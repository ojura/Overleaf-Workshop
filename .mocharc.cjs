// mocha's configuration for this repository. mocha looks for it from its working folder upward, so
// it applies also to a run started in a subfolder, and the path below does not depend on that folder.
'use strict';
const path = require('node:path');

module.exports = {
    require: [path.join(__dirname, 'scripts', 'lib', 'report-unhandled-rejections.cjs')],
};
