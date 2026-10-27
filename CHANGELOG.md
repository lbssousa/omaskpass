# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions
follow [Semantic Versioning](https://semver.org/). Version 0.1.0 was never
tagged.

## [Unreleased]

### Changed
- The shell plugin moved from `plugin/` to the repository root
  (`manifest.json`, `SshAskpassService.qml`, `SshAskpassDialog.qml`), so
  the Omarchy plugin marketplace and `omarchy plugin add` can install it.
  The packages install the same files to the same place
  (`share/omaskpass/plugin`). The manifest gains `license`, `homepage`,
  `repository` and `keywords`.
- `dev/` no longer carries symlinks, which plugins may not have: `just dev`
  and `just test-plugin` build their Quickshell folder in a temporary
  directory. `just link` links the checkout itself and rescans the shell's
  plugins.

### Added
- README sections on installing the plugin alone (`omarchy plugin add`)
  and on removing omaskpass.
- Flake modules for NixOS (`nixosModules.default`) and Home Manager
  (`homeModules.default`, also as `homeManagerModules`), both as
  `programs.omaskpass`. They install the package and do the README's
  per-user steps.

## [0.3.1] - 2026-10-20

### Added
- Packaging: an Arch package (`packaging/PKGBUILD`, `just pkg`) and a Nix
  flake (`flake.nix`, `nix/package.nix`, `just nix`) with
  `packages.<system>.default`, `overlays.default`, a dev shell and
  `nix flake check`. Both install the binary as `bin/omaskpass` and the
  shell plugin under `share/omaskpass/plugin`, the same layout as omapin.
- `just link` loads the checkout's plugin in the real shell.

## [0.3.0] - 2026-10-20

### Changed
- Renamed from ssh-askpass-omarchy to omaskpass, along with the GitHub
  repository (`lbssousa/omaskpass`; the old URL redirects). Everything
  named after the project changes with it:
  - binary: `omaskpass`;
  - socket: `$XDG_RUNTIME_DIR/omaskpass.sock`;
  - environment variable: `OMASKPASS_SOCKET`;
  - shell plugin id: `lbssousa.omaskpass`;
  - Wayland layer namespace of the dialog: `omaskpass` (was
    `omarchy-ssh-askpass`).

  To upgrade, replace the `~/.config/omarchy/plugins/lbssousa.ssh_askpass`
  link with one named `lbssousa.omaskpass`, enable `lbssousa.omaskpass`
  and point `SSH_ASKPASS` at the new binary.

### Added
- **Host key questions in plain text.** OpenSSH's yes/no questions
  ("Are you sure you want to continue connecting
  (yes/no/[fingerprint])?", "Please type 'yes' or 'no':",
  "Accept updated hostkeys? (yes/no):") are asked in a visible text field
  instead of a password field. OpenSSH gives the askpass no hint for them,
  so they are recognized by their text; a question inside a key path keeps
  the password field.
- Protocol v3: the new `text` mode. A plugin and a binary from different
  versions refuse each other.

### Fixed
- A host key prompt that lists many other names for the key no longer
  loses its question to the 6-line limit: the question always stays on the
  last line.

## [0.2.0] - 2026-10-02

### Added
- **Security key touch prompt.** When OpenSSH runs the askpass with
  `SSH_ASKPASS_PROMPT=none` for "Confirm user presence for key …", the
  dialog shows a pulsing key and "Touch your security key" until OpenSSH
  kills the askpass. Other notifications get a message with **Dismiss**.
- **Key use confirmations.** `SSH_ASKPASS_PROMPT=confirm` (`ssh-add -c`)
  shows **Deny** / **Allow**. It used to show a passphrase field, and any
  Enter allowed the use.
- Protocol v2: requests carry a `mode` (`passphrase`, `confirm`, `notify`).
  A plugin and a binary from different versions refuse each other.
- Integration tests against a fake dialog (`tests/askpass.rs`), protocol
  tests against the real QML plugin (`tests/plugin.rs`, `just test-plugin`)
  and cargo-fuzz targets for the reply parser, the prompt cleaner and the
  passphrase decoding (`fuzz/`, `just fuzz`).
- GitHub security tooling: CI, CodeQL, cargo-deny, OpenSSF Scorecard,
  Dependabot and fuzzing workflows, a security policy and a contribution
  guide.

### Security
- The binary is non-dumpable (no core dumps, no same-uid ptrace) and locks
  its memory (`mlockall`).
- The passphrase is written to stdout through an unbuffered file. It used
  to pass through std's stdout buffer, which kept a copy of it unwiped.
- Confirmations fail closed: only a literal `ok` allows; errors, a busy
  shell, a closed connection or garbage deny. **Deny** is the default
  button and Enter never allows.
- A passphrase reply with JSON escapes is refused instead of unescaped
  into unwiped scratch memory, and `ok` without a password is an error.
- The prompt is cleaned before it is shown: control characters,
  bidirectional overrides, zero-width characters and line separators are
  removed, blank lines collapse, and it is cut to 6 lines and 2000 bytes.
  What the dialog sends back is never echoed to stderr; failures are
  reported as fixed texts.
- A prompt that isn't valid UTF-8 no longer aborts the binary (the build
  uses `panic = "abort"`).
- The plugin refuses requests with a non-string or overlong prompt and
  lowers its request size limit to 16 KiB. It only hands the typed text over
  for an answered passphrase prompt.
- The crate forbids `unsafe` code (`#![forbid(unsafe_code)]`).
- `Cargo.lock` is now tracked, so builds and CI use the audited versions.
