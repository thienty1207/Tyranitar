# Tyrant Engine

Tyrant is a local MCP orchestrator for coding agents. It applies its Matt Pocock inspired workflow, brings in project memory from AI-Memory and Graphify, and routes relevant specialist skills. Tyrant does not make model requests itself.

## Install on Windows

Open PowerShell and run:

```powershell
irm https://github.com/thienty1207/Tyranitar/releases/latest/download/install.ps1 | iex
```

The installer downloads the latest stable Tyrant release, checks the package against GitHub's published SHA-256 digest, installs it for the current Windows user, and adds `tyrant` to the user PATH. It installs Bun if Bun 1.4 or newer is not already available. Open a new terminal after installation, then check:

```powershell
tyrant --version
```

This release supports Windows x64. It does not require Git, Node.js, Python, `uv`, or a manual Bun installation.

## Choose your default AI-Memory vault

Run `tyrant setup` once for the vault you want new projects to use:

```powershell
tyrant setup "D:\AI-MEMORY" --name "AI-MEMORY"
```

Choose any folder and label you like. Tyrant creates the folder if needed, configures AI-Memory there, and installs or checks the pinned Graphify runtime. The last vault passed to `tyrant setup` becomes the default for projects initialized afterward. You can run the command from inside an existing vault folder without passing a path:

```powershell
Set-Location "D:\AI-MEMORY"
tyrant setup
```

Tyrant keeps the AI-Memory vault at the path you selected. It keeps its managed Graphify, `uv`, and Python runtimes under `%LOCALAPPDATA%\Tyrant\runtimes\`. Graphify is provisioned by `tyrant setup`; it is not a vendored source folder under `vendor/`. You do not install Graphify or `uv` yourself.

## Initialize a project

Open PowerShell in the project folder and run:

```powershell
Set-Location "D:\path\to\your-project"
tyrant init
```

Tyrant binds that project to the current default vault, gives it a separate AI-Memory project scope, installs the selected host adapters and skills, and registers it so `tyrant update` can refresh Tyrant managed project files later. Repeat this once for each project.

To initialize a project with a different saved vault:

```powershell
tyrant init --vault "another-vault-label"
```

Changing the default with `tyrant setup` does not silently move projects that are already initialized. To deliberately rebind an existing project, run `tyrant init --vault "another-vault-label"` from that project folder.

## Switch between vaults

Set whichever vault should be the default for the next projects by running setup for that vault again:

```powershell
tyrant setup "D:\AI-MEMORY-WEBDEV" --name "AI-MEMORY-WEBDEV"
tyrant setup "D:\AI-MEMORY-DESKTOPDEV" --name "AI-MEMORY-DESKTOPDEV"
```

The labels are user supplied; Tyrant does not treat them as built in project types. Projects already bound to a vault continue using their saved binding until you explicitly rebind them.

## Update Tyrant

After a release is published, update the installation with:

```powershell
tyrant update
```

The updater checks the release digest before installing the new version, refreshes the saved DSH profile, and refreshes registered projects only when Tyrant's ownership hashes still match. It leaves user edited managed files untouched and reports any project it could not refresh. If DSH was already open, restart it once so it loads the updated plugin.

## Check the setup

From an initialized project folder:

```powershell
tyrant status
tyrant doctor
```

`status` shows the project's saved vault binding and the local adapter state. `doctor` also checks AI-Memory connectivity and the pinned Graphify version. Neither command prints the AI-Memory bearer token.

Codex, DeepSeek Harness, OpenCode, and Claude Code have automatic project integrations when initialized for those hosts. A host may still ask you to trust or enable its project hook once. Claude Desktop supports MCP connection configuration but does not have the same automatic pre prompt hook behavior.

## Where Tyrant keeps data

- Your AI-Memory notes and handoffs stay in the vault folder you selected with `tyrant setup`.
- Tyrant's install, Graphify runtimes, and local task state stay under `%LOCALAPPDATA%\Tyrant\`.
- Each initialized project stores its vault binding and Tyrant managed adapter files in that project's `.tyrant\` folder.
- AI-Memory history is treated as untrusted historical context; current project files and instructions remain authoritative.

For architecture, skill routing, provider contracts, and the known host limitations, see [`docs/`](docs/).
