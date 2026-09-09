# Versioning

Development builds default to build number 1. Set PENTACLE_BUILD_NUMBER to a
positive integer to assign a release number. A production build
(PENTACLE_PROD_BUILD=1 or EAS_BUILD_PROFILE=production) requires an explicit
number. Choose a number greater than the previous release for your app identity.
Build numbers do not depend on private repository history or clone depth.

The marketing version starts at 1.0.0 for build 1. The default minor mode
makes build 2 version 1.1.0; PENTACLE_VERSION_BUMP=patch makes it 1.0.1,
and PENTACLE_VERSION_BUMP=major makes it 2.0.0.
scripts/ios-marketing-version.cjs calls the same version function as Expo.

The Expo runtime version uses the marketing version through the appVersion
policy. Keep the selected bump mode consistent throughout each build.
