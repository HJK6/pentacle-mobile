const React = require('react');

function FontAwesome(props) {
  return React.createElement('FontAwesome', props, props.children);
}

module.exports = FontAwesome;
module.exports.default = FontAwesome;
