# Install

One-line install from the main repository:

```bash
curl -fsSL https://raw.githubusercontent.com/thewronghand-bigs/mailman/main/install.sh | INSTALL_TARGET=codex bash
```

This directory is meant to become its own repository for team distribution.

## Home-local plugin install

1. Copy or clone this package so the plugin root lives at:

```text
~/plugins/mailman-sandbox
```

2. Add a local marketplace entry in:

```text
~/.agents/plugins/marketplace.json
```

Example:

```json
{
  "name": "company-local",
  "interface": {
    "displayName": "Company Local"
  },
  "plugins": [
    {
      "name": "mailman-sandbox",
      "source": {
        "source": "local",
        "path": "./plugins/mailman-sandbox"
      },
      "policy": {
        "installation": "AVAILABLE",
        "authentication": "ON_INSTALL"
      },
      "category": "Productivity"
    }
  ]
}
```

3. Prepare runtime config:

```bash
cd ~/plugins/mailman-sandbox/runtime
cp config.example.json config.json
bun install
```

After install, use the short skill name `mailman` in sandbox conversations.

## Team distribution

- Put this package in its own repository, for example `mailman-sandbox-plugin`
- Ask team members to clone it to `~/plugins/mailman-sandbox`
- Share the marketplace snippet above or provide a bootstrap script that writes it once
