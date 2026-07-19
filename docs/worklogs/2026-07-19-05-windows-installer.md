# Windows Installer Packaging

## Objective

Add a standard Windows x64 EXE installer for Codex Browser 1.1.0 in addition to the existing portable ZIP.

## Decisions

- Use Inno Setup 6 to create a conventional installer with a registered uninstaller.
- Install per-user under `%LocalAppData%\Programs\Codex Browser` so elevation is not required.
- Create a Start Menu shortcut and offer an opt-in desktop shortcut.
- Preserve browser and application user data during uninstall; only installed program files are removed.
- Build the installer from the already-verified portable payload so both distribution forms contain identical runtime files and the Edge relay extension.

## Changes

- Added the version-parameterized Inno Setup definition under `installer/`.
- Added repeatable `package:installer` and `smoke:installer` commands.
- Added SHA-256 generation for the installer and a bounded silent install/uninstall verification.
- Updated README and 1.1.0 release notes with installer guidance.

## Verification

- `node --check scripts/package-windows-installer.mjs`: passed.
- `node --check scripts/installer-smoke.mjs`: passed.
- `npm run package:installer`: passed after the normal production build and portable-package build.
- Inno Setup 6.7.3 compiled `CodexBrowser-1.1.0-win-x64-setup.exe`, 115,307,143 bytes.
- Installer SHA-256: `6d5c4536ef111fca9a02ccda1f518610ccd466896c8cfe68657f50f8b7bb2543`.
- `npm run smoke:installer`: passed. Silent per-user installation contained the application, broker, MCP, Electron runtime, and Edge relay extension; silent uninstall removed installed application files.
- Git commit and GitHub Release upload remain pending the final publication steps.

## Known Issues

- The installer is not code-signed, so Windows SmartScreen may show an unknown-publisher warning.
- Node.js and Microsoft Edge remain prerequisites rather than being bundled into the installer.

## Next Steps

- Commit and push the installer build definition, then upload the EXE and checksum to the existing 1.1.0 draft Release.
