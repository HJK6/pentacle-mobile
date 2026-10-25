Pod::Spec.new do |s|
  s.name = 'PentacleMessageText'
  s.version = '1.0.0'
  s.summary = 'Read-only native message text selection'
  s.description = s.summary
  s.license = { :type => 'MIT' }
  s.author = 'Pentacle'
  s.homepage = 'https://github.com/HJK6/pentacle-mobile'
  s.platforms = { :ios => '15.1' }
  s.source = { :git => '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files = '**/*.swift'
end
