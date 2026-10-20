# NixOS module (nixosModules.default): installs omaskpass system-wide,
# makes it the SSH askpass and links the shell plugin for every user.
# Enabling the plugin in the shell is left to each user's session
# (`omarchy-shell shell enablePlugin lbssousa.omaskpass '{}'`), or to the
# Home Manager module.
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.programs.omaskpass;
  pluginId = "lbssousa.omaskpass";
in
{
  options.programs.omaskpass = {
    enable = lib.mkEnableOption "omaskpass, an SSH askpass in the Omarchy shell's polkit-style dialog";

    package = lib.mkOption {
      type = lib.types.package;
      default = pkgs.callPackage ./package.nix { };
      defaultText = lib.literalExpression "omaskpass.packages.\${system}.default";
      description = "The omaskpass package.";
    };

    require = lib.mkOption {
      type = lib.types.enum [
        "prefer"
        "force"
        "never"
      ];
      default = "prefer";
      description = ''
        SSH_ASKPASS_REQUIRE. "prefer" makes ssh use the askpass even when it
        runs in a terminal.
      '';
    };
  };

  config = lib.mkIf cfg.enable {
    environment.systemPackages = [ cfg.package ];

    # SSH_ASKPASS for every session, and for the ssh-agent user service.
    programs.ssh = {
      enableAskPassword = true;
      askPassword = lib.getExe cfg.package;
    };
    environment.variables.SSH_ASKPASS_REQUIRE = cfg.require;

    # Third-party shell plugins are only discovered in
    # ~/.config/omarchy/plugins/.
    systemd.user.tmpfiles.rules = [
      "L+ %h/.config/omarchy/plugins/${pluginId} - - - - ${cfg.package}/share/omaskpass/plugin"
    ];
  };
}
