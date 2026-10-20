# Home Manager module (homeModules.default): what the README's "Per user"
# steps do, for one user.
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.programs.omaskpass;
  pluginId = "lbssousa.omaskpass";
  askpassVariables = {
    SSH_ASKPASS = lib.getExe cfg.package;
    SSH_ASKPASS_REQUIRE = cfg.require;
  };
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

    enablePlugin = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = ''
        Whether to enable the ${pluginId} plugin in the running omarchy-shell
        on activation (`omarchy-shell shell enablePlugin`). The shell records
        it in ~/.config/omarchy/shell.json. Without a running shell this only
        prints a warning.
      '';
    };
  };

  config = lib.mkIf cfg.enable {
    home.packages = [ cfg.package ];

    # Third-party shell plugins are only discovered here.
    xdg.configFile."omarchy/plugins/${pluginId}".source = "${cfg.package}/share/omaskpass/plugin";

    # Login shells, and (through ~/.config/environment.d) the systemd user
    # session, so that an ssh-agent started there asks through it too. Log
    # in again to pick them up.
    home.sessionVariables = askpassVariables;
    systemd.user.sessionVariables = askpassVariables;

    home.activation.omaskpassEnablePlugin = lib.mkIf cfg.enablePlugin (
      lib.hm.dag.entryAfter [ "linkGeneration" ] ''
        omarchy_shell=$(PATH="$PATH:/usr/bin" command -v omarchy-shell || true)
        if [[ -n $omarchy_shell && ! -v DRY_RUN ]]; then
          if [[ $("$omarchy_shell" shell enablePlugin ${pluginId} '{}' 2>/dev/null) != ok ]]; then
            warnEcho "Couldn't enable the ${pluginId} shell plugin (is omarchy-shell running?)."
            warnEcho "Run: omarchy-shell shell enablePlugin ${pluginId} '{}'"
          fi
        fi
      ''
    );
  };
}
