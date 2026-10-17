"use strict";
const os = require("node:os");
const path = require("node:path");
// os.homedir() ignores $HOME on Windows, so tests isolate via an explicit override instead.
function tempHome(prefix) {
  return require("node:fs").mkdtempSync(path.join(os.tmpdir(), prefix + "-"));
}
module.exports = { tempHome };
