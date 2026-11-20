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

Open PowerShell in the folder you want to use as your AI-Memory vault, then run:

```powershell
tyrant setup
```

Tyrant initializes AI-Memory for that vault, installs or checks its managed Graphify runtime, and makes that folder the default vault for projects you initialize afterward. You do not need to pass a path or a profile name.

Tyrant keeps the AI-Memory vault at the path you selected. It keeps its managed Graphify, `uv`, and Python runtimes under `%LOCALAPPDATA%\Tyrant\runtimes\`. Graphify is provisioned by `tyrant setup`; it is not a vendored source folder under `vendor/`. You do not install Graphify or `uv` yourself.

## Initialize a project

Open PowerShell in the project folder, then run:

```powershell
tyrant init
```

Tyrant binds a new project to the current default vault, gives it a separate AI-Memory project scope, installs the selected host adapters and skills, and registers it so `tyrant update` can refresh Tyrant-managed project files later. Repeat this once for each project. An already initialized project keeps its saved vault binding if you change the default later.

## Switch between vaults

To switch the default, open PowerShell in the other vault folder and run the same single command: `tyrant setup`. New projects initialized afterward use that vault. Existing projects keep their saved bindings.

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
