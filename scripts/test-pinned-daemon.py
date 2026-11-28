#!/usr/bin/env python3
"""Run the mobile transport against an isolated pinned daemon on hosted CI."""
import ast
import json
import os
from pathlib import Path
import queue
import re
import signal
import subprocess
import sys
import tempfile
import threading
import time

ROOT = Path(__file__).resolve().parents[1]
PIN = ROOT / 'config/pentacle-daemon-pin.json'


def run(*args, **kwargs):
    subprocess.run(args, check=True, **kwargs)


def main():
    if os.environ.get('GITHUB_ACTIONS') != 'true':
        raise SystemExit('Pinned daemon journey runs only on GitHub-hosted Actions runners.')
    pin = json.loads(PIN.read_text())
    if pin.get('repo') != 'HJK6/pentacle' or not re.fullmatch(r'[0-9a-f]{40}', pin.get('commit', '')):
        raise SystemExit('Invalid daemon pin')
    requested = os.environ.get('PENTACLE_DAEMON_REF') or pin['commit']
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._/-]*', requested):
        raise SystemExit('Invalid daemon ref')
    print(f'requested pin: {requested}', flush=True)
    with tempfile.TemporaryDirectory(prefix='mobile-daemon-') as directory:
        root = Path(directory)
        checkout = root / 'daemon'
        print('stage: checkout', flush=True)
        run('git', 'clone', '--quiet', 'https://github.com/HJK6/pentacle.git', str(checkout))
        checkout_ref = 'origin/main' if requested == 'main' else requested
        run('git', '-C', str(checkout), 'checkout', '--quiet', '--detach', checkout_ref)
        # Disposable RED proof: remove history rows from the checked-out daemon.
        server = checkout / 'services/chat-stream-v2/server.py'
        source = server.read_text()
        original = '                page = rows[-quota:] if has_more else rows[:quota]\n'
        if source.count(original) != 1:
            raise RuntimeError('RED patch target changed')
        server.write_text(source.replace(original, original + '                page = []\n', 1))
        run('git', '-C', str(checkout), 'diff', '--stat')
        head = subprocess.check_output(['git', '-C', str(checkout), 'rev-parse', 'HEAD'], text=True).strip()
        print(f'checked-out HEAD: {head}', flush=True)
        if not os.environ.get('PENTACLE_DAEMON_REF') and head != requested:
            raise RuntimeError('Daemon checkout differs from pin')
        # The disposable RED branch patches the checkout here, before daemon startup.
        service = checkout / 'services/chat-stream-v2'
        print('stage: dependencies', flush=True)
        run(sys.executable, '-m', 'pip', 'install', '-r', str(service / 'requirements.txt'), stdout=subprocess.DEVNULL)
        fixture_home = root / 'daemon-home'
        fixture_home.mkdir(mode=0o700)
        registry = fixture_home / '.config/pentacle-stream/operator-credentials.json'
        clean_env = {'PATH': os.environ.get('PATH', ''), 'PYTHONUNBUFFERED': '1'}
        print('stage: credential', flush=True)
        issued = subprocess.check_output([
            sys.executable, str(service / 'tools/operator_auth_cli.py'), '--registry', str(registry),
            'issue', '--client-kind', 'pentacle-mobile',
        ], env=clean_env, text=True)
        token = root / 'credential'
        token.write_text(json.loads(issued)['code'])
        token.chmod(0o600)
        seed_script = checkout / 'test/e2e/lib/seed_web_gate.py'
        database = root / 'sessions.db'
        print('stage: seed', flush=True)
        seed = json.loads(subprocess.check_output([
            sys.executable, str(seed_script), '--db', str(database), '--host', 'fixture',
            '--session', 'mobile-journey',
        ], env=clean_env, text=True))
        tree = ast.parse(seed_script.read_text())
        transcript = next(ast.literal_eval(node.value) for node in tree.body
                          if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == 'TRANSCRIPT' for t in node.targets))
        seed['transcript'] = transcript
        seed_file = root / 'seed.json'
        seed_file.write_text(json.dumps(seed))
        daemon_env = {**clean_env, 'HOME': str(fixture_home), 'PENTACLE_RESTART_NOTICE': '0',
                      'PENTACLE_MACHINES_JSON': '{"machines":[{"name":"fixture"}]}'}
        args = [sys.executable, 'main.py', '--port', '0', '--db', str(database), '--local-host', 'fixture',
                '--notifications-db', str(root / 'notifications.db'), '--assets-db', str(root / 'assets.db'),
                '--blob-root', str(root / 'blobs')]
        print('stage: daemon startup', flush=True)
        daemon = subprocess.Popen(args, cwd=service, env=daemon_env, stdout=subprocess.PIPE,
                                  stderr=subprocess.STDOUT, text=True, start_new_session=True)
        output = queue.Queue()
        def read_output():
            for line in daemon.stdout:
                output.put(line)
        threading.Thread(target=read_output, daemon=True).start()
        try:
            deadline = time.monotonic() + 30
            port = None
            while time.monotonic() < deadline and daemon.poll() is None:
                try:
                    line = output.get(timeout=0.2)
                except queue.Empty:
                    continue
                match = re.search(r'listening on .*:(\d+)\s*$', line)
                if match:
                    port = int(match.group(1))
                    break
            if not port:
                raise RuntimeError('Daemon did not announce its listener within 30 seconds')
            test_env = dict(os.environ, PINNED_DAEMON_URL=f'ws://127.0.0.1:{port}',
                            PINNED_DAEMON_TOKEN_FILE=str(token), PINNED_DAEMON_SEED_FILE=str(seed_file),
                            PINNED_DAEMON_HEAD=head)
            print('stage: authenticated journey', flush=True)
            run('npm', 'run', 'test:daemon-pinned', cwd=ROOT, env=test_env)
        finally:
            if daemon.poll() is None:
                os.killpg(daemon.pid, signal.SIGTERM)
            try:
                daemon.wait(timeout=10)
            except subprocess.TimeoutExpired:
                os.killpg(daemon.pid, signal.SIGKILL)
                daemon.wait()


if __name__ == '__main__':
    main()
