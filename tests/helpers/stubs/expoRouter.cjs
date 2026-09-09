const React = require('react');

function useRouter() {
  return {
    back() {},
    canGoBack() {
      return false;
    },
    push() {},
    replace() {},
  };
}

function useLocalSearchParams() {
  return {};
}

function Stack(props) {
  return React.createElement('Stack', props, props.children);
}

Stack.Screen = function Screen(props) {
  return React.createElement('Stack.Screen', props, null);
};

module.exports = {
  Stack,
  useLocalSearchParams,
  useRouter,
};
