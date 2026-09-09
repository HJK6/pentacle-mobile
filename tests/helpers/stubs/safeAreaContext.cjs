const React = require('react');

function SafeAreaProvider(props) {
  return React.createElement('SafeAreaProvider', props, props.children);
}

function useSafeAreaInsets() {
  return { bottom: 0, left: 0, right: 0, top: 0 };
}

module.exports = {
  SafeAreaProvider,
  useSafeAreaInsets,
};
