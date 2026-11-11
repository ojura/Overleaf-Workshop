# GitHub Actions Overview

These workflows define the repository's automated tasks. Their availability also depends on
the repository's Actions settings and configured credentials.

- **vsce-package.yml**: Call `vsce package` to create a temporary VSCode extension package when a Pull Request is created/updated on the `master` branch.

- **vsce-publish.yml**: Runs daily and on manual dispatch against `master`. When `package.json`
  has changed in the previous 24 hours, it packages the extension and publishes to the VS Code
  Marketplace and Open VSX using the repository's `VSCE_PAT` and `OVSX_TOKEN` secrets.
