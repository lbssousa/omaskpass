# Builds the same files as packaging/PKGBUILD: the binary in bin/ and the
# shell plugin in share/omaskpass/plugin. The version comes from Cargo.toml.
{
  lib,
  rustPlatform,
  util-linux,
}:
let
  cargoToml = (lib.importTOML ../Cargo.toml).package;
in
rustPlatform.buildRustPackage {
  pname = cargoToml.name;
  inherit (cargoToml) version;

  src = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [
      ../Cargo.toml
      ../Cargo.lock
      ../src
      ../tests
      ../plugin
    ];
  };

  cargoLock.lockFile = ../Cargo.lock;

  # tests/askpass.rs signals the binary with kill(1).
  nativeCheckInputs = [ util-linux ];

  postInstall = ''
    install -Dm644 -t $out/share/omaskpass/plugin plugin/manifest.json plugin/*.qml
  '';

  meta = {
    description = cargoToml.description;
    homepage = "https://github.com/lbssousa/omaskpass";
    license = lib.licenses.mit;
    mainProgram = "omaskpass";
    platforms = lib.platforms.linux;
  };
}
