# rbx-iconify

Use any of the 200,000+ open source icons on [Iconify](https://icon-sets.iconify.design/) in your Roblox game — just reference them by name in your Luau code.

`rbx-iconify` scans your Luau sources for icon references like `"lucide:x"`, fetches the icons from the Iconify API, and generates:

- **Sprite sheet PNGs** — white-on-transparent tiles, tintable at runtime via `ImageColor3`
- **A Luau index module** — maps each icon name to its sheet, offset, and size

No icon packages to install, no manual sprite management. Add an icon string to your code, run the tool, done.

## Installation

Download a prebuilt binary from [Releases](https://github.com/revvy02/rbx-iconify/releases), or install with a toolchain manager:

```sh
# rokit
rokit add revvy02/rbx-iconify

# mise
mise use ubi:revvy02/rbx-iconify
```

Or run from source (Node.js 22+):

```sh
npm install
node index.js
```

## Quick start

Create an `iconify.toml` in your project root:

```toml
scan = ["src/**/*.luau"]
output = "src/shared/iconify.luau"
default_set = "lucide"

[target.ui]
path = "assets/images/ui.png"
tile_size = 64
columns = 16
```

Reference icons anywhere in your scanned sources as string literals:

```lua
someIcon("lucide:x")
someIcon("ph:gear-six")
```

Run `rbx-iconify` from the project root (or `rbx-iconify --watch` during development). It writes `assets/images/ui_1.png` and the index module at `output`.

The generated module is a lookup function:

```lua
local iconify = require(path.to.iconify)

local icon = iconify("lucide:x", "ui")
-- icon.sheet  → 1 (which sprite sheet the icon is on)
-- icon.offset → Vector2 (pixel offset within the sheet)
-- icon.size   → Vector2 (tile size)
```

Upload the sheet PNGs as image assets, then wire it up:

```lua
local SHEETS = { "rbxassetid://<ui_1 asset id>" }

image.Image = SHEETS[icon.sheet]
image.ImageRectOffset = icon.offset
image.ImageRectSize = icon.size
image.ImageColor3 = Color3.fromRGB(255, 170, 0) -- icons are white, tint freely
```

Sheets are capped at 4096px; overflow spills into `ui_2.png`, `ui_3.png`, etc. (`icon.sheet` tells you which).

## Icon references

Any string literal in scanned files matching `set:name` is picked up, where `set` is a known [Iconify prefix](https://icon-sets.iconify.design/) (`lucide`, `ph`, `mdi`, ...).

### Generic names

The `default` pseudo-set lets you decouple call sites from a specific icon set:

```toml
default_set = "lucide"

[default]
close = "lucide:x"
settings = "ph:gear-six"
```

```lua
someIcon("default:close")        -- → lucide:x (explicit alias)
someIcon("default:chevron-down") -- → lucide:chevron-down (falls back to default_set)
```

Swap the whole icon set for your game by changing one line of config.

### Style overrides

Styles cascade in three layers — set defaults, per-icon overrides, then call-site overrides:

```toml
[lucide]
stroke_width = 2       # applies to every lucide icon

["lucide:x"]
stroke_width = 3       # just this icon
```

```lua
someIcon("lucide:x:stroke_width=1") -- call site wins; rendered as its own variant
```

Each distinct override combination becomes its own tile on the sheet. Currently `stroke_width` is the supported style property.

## Configuration reference

| Key | Description |
|-----|-------------|
| `scan` | Glob patterns of Luau files to scan. Omit to scan every `.luau` under the cwd. |
| `output` | Path of the generated Luau index module. |
| `default_set` | Icon set used for unmapped `default:*` references. |
| `[target.<name>]` | A sprite sheet target. Multiple targets render the same icons at different resolutions. |
| `[target.<name>].path` | Sheet PNG path. Sheet number is suffixed: `ui.png` → `ui_1.png`. |
| `[target.<name>].tile_size` | Tile resolution in pixels (default `64`). |
| `[target.<name>].columns` | Max columns per sheet (default `16`). |
| `[default]` | Alias table mapping generic names to `set:icon`. |
| `[<set>]` | Style defaults for every icon in a set. |
| `["<set>:<icon>"]` | Style overrides for a single icon. |

## CLI

```
rbx-iconify [options]

  --watch        Re-run when scanned source files change
  -v, --version  Print version
  -h, --help     Print help
```

## Development

```sh
npm install
npm test        # fixture-based end-to-end tests (hits the Iconify API)
```

Build a standalone binary with [Bun](https://bun.sh):

```sh
bun build --compile --loader .wasm:file index.js --outfile rbx-iconify
```

Rendering uses `@resvg/resvg-wasm` + `pngjs` (no native modules), so the compiled binary is fully self-contained and cross-compiles to all release targets from any machine.

## License

[MIT](LICENSE)
