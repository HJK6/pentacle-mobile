# Generate a disposable simulator-only XCUITest project. No app/toolchain mutation.
require 'xcodeproj'
require 'fileutils'

output, app_id = ARGV
abort 'usage: ruby prepare.rb ABSOLUTE_OWNED_OUTPUT INSTALLED_SYNTHETIC_APP_ID' unless output&.start_with?('/') && app_id && !app_id.empty?
url = ENV.fetch('PENTACLE_VIEWER_HARNESS_URL')
project_path = File.join(output, 'ImageViewerGestures.xcodeproj')
abort 'output project already exists; preserve it and choose a new owned output' if File.exist?(project_path)
FileUtils.mkdir_p(output)
project = Xcodeproj::Project.new(project_path)
target = project.new_target(:ui_test_bundle, 'ImageViewerGestures', :ios, '15.1')
source = project.main_group.new_file(File.expand_path('ImageViewerUITests.swift', __dir__))
target.source_build_phase.add_file_reference(source)
target.build_configurations.each do |config|
  config.build_settings.merge!({
    'PRODUCT_BUNDLE_IDENTIFIER' => 'com.example.pentacle.image-viewer-gestures',
    'PRODUCT_NAME' => '$(TARGET_NAME)',
    'GENERATE_INFOPLIST_FILE' => 'YES',
    'SWIFT_VERSION' => '5.0',
    'SUPPORTED_PLATFORMS' => 'iphonesimulator',
    'SDKROOT' => 'iphonesimulator',
    'TARGETED_DEVICE_FAMILY' => '1,2',
    'CODE_SIGN_IDENTITY' => '-',
    'CODE_SIGNING_ALLOWED' => 'YES',
  })
end
project.save
scheme = Xcodeproj::XCScheme.new
scheme.add_build_target(target)
scheme.add_test_target(target)
scheme.test_action.build_configuration = 'Release'
scheme.test_action.xml_element.attributes['shouldUseLaunchSchemeArgsEnv'] = 'NO'
scheme.test_action.environment_variables = Xcodeproj::XCScheme::EnvironmentVariables.new([
  { key: 'PENTACLE_VIEWER_APP_ID', value: app_id, enabled: true },
  { key: 'PENTACLE_VIEWER_HARNESS_URL', value: url, enabled: true },
])
scheme.save_as(project_path, 'ImageViewerGestures', true)
puts project_path
