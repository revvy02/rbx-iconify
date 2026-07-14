// rbx-iconify — generates sprite sheets + Luau metadata from icon usage
//
// Reads:
//   iconify.toml (in cwd) — config (targets, set defaults, per-icon overrides, defaults)
//
// Scans:
//   all .luau files for string literals matching known Iconify prefixes
//
// Fetches:
//   icon data from the Iconify API (no local icon packages needed)
//
// Writes:
//   sprite PNGs per target as <output.sheets>/<target>/<n>.png (split at 4096px max)
//   Luau metadata at path from iconify.toml `output.index`

import { readFileSync, writeFileSync, unlinkSync, mkdirSync, readdirSync, globSync, watch } from "fs"
import { join, dirname } from "path"
import { createRequire } from "module"
import { initWasm, Resvg } from "@resvg/resvg-wasm"
import { PNG } from "pngjs"
import { iconToSVG, replaceIDs } from "@iconify/utils"
import TOML from "@iarna/toml"
import pkg from "./package.json" with { type: "json" }

const args = process.argv.slice(2)

if (args.includes("--version") || args.includes("-v")) {
	console.log(pkg.version)
	process.exit(0)
}

if (args.includes("--help") || args.includes("-h")) {
	console.log(`rbx-iconify v${pkg.version}
Generates sprite sheets + Luau metadata from Iconify icon usage in Luau sources.

Usage: rbx-iconify [options]

Reads iconify.toml from the current directory.

Options:
  --watch        Re-run when scanned source files change
  -v, --version  Print version
  -h, --help     Print this help`)
	process.exit(0)
}

const MAX_RESOLUTION = 4096
const ICONIFY_API = "https://api.iconify.design"
const WATCH_MODE = args.includes("--watch")

// --- Config parsing ---

function parseConfig(tomlString) {
	const config = TOML.parse(tomlString)

	const targets = {}
	const defaults = config.default || {}
	const setDefaults = {}
	const iconOverrides = {}

	for (const [key, value] of Object.entries(config)) {
		if (typeof value !== "object" || Array.isArray(value)) continue
		if (key === "target") {
			for (const [name, targetConfig] of Object.entries(value)) {
				targets[name] = {
					tileSize: targetConfig.tile_size || 64,
					columns: targetConfig.columns || 16,
				}
			}
		} else if (key === "default" || key === "output") {
			// already captured above
		} else if (key.includes(":")) {
			iconOverrides[key] = value
		} else {
			setDefaults[key] = value
		}
	}

	if (!config.output?.index || !config.output?.sheets) {
		throw new Error(`iconify.toml needs an [output] table with "index" (Luau module path) and "sheets" (sprite sheet directory)`)
	}

	return {
		indexPath: config.output.index,
		sheetsDir: config.output.sheets,
		scan: config.scan || null,
		defaultSet: config.default_set || null,
		targets,
		defaults,
		setDefaults,
		iconOverrides,
	}
}

// --- Source scanning ---

async function fetchPrefixes() {
	const res = await fetch(`${ICONIFY_API}/collections`)
	const collections = await res.json()
	return Object.keys(collections)
}

function walkLuauFiles(root, outputAbsPath) {
	const files = []
	function walk(dir) {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (entry.name === "node_modules" || entry.name === ".git") continue
			const fullPath = join(dir, entry.name)
			if (entry.isDirectory()) {
				walk(fullPath)
			} else if (entry.name.endsWith(".luau") && fullPath !== outputAbsPath) {
				files.push(fullPath)
			}
		}
	}
	walk(root)
	return files
}

function scanSourceFiles(root, prefixes, config) {
	const icons = new Set()
	const allPrefixes = [...prefixes, "default"]
	const prefixPattern = allPrefixes.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")
	const regex = new RegExp(`["']((?:${prefixPattern}):[a-z0-9_-]+(?::[a-z0-9_=,]+)*)["']`, "gi")
	const outputAbsPath = join(root, config.indexPath)

	const files = config.scan
		? config.scan.flatMap((pattern) => globSync(pattern, { cwd: root }).map((f) => join(root, f)))
		: walkLuauFiles(root, outputAbsPath)

	for (const filePath of files) {
		if (filePath === outputAbsPath) continue
		const source = readFileSync(filePath, "utf8")
		for (const match of source.matchAll(regex)) {
			icons.add(match[1])
		}
	}

	return [...icons].map((name) => ({ name }))
}

// --- Manifest processing ---

function parseVariantKey(variantKey) {
	const parts = variantKey.split(":")
	if (parts.length < 2) {
		return { baseName: variantKey, callSiteOverrides: {} }
	}

	const baseName = `${parts[0]}:${parts[1]}`
	const callSiteOverrides = {}

	for (let i = 2; i < parts.length; i++) {
		const overrideParts = parts[i].split(",")
		for (const part of overrideParts) {
			const eqIdx = part.indexOf("=")
			if (eqIdx !== -1) {
				const key = part.slice(0, eqIdx)
				const val = part.slice(eqIdx + 1)
				callSiteOverrides[key] = isNaN(Number(val)) ? val : Number(val)
			}
		}
	}

	return { baseName, callSiteOverrides }
}

function buildIconList(scannedIcons, config) {
	const { defaultSet, defaults, setDefaults, iconOverrides } = config
	const variants = new Map()

	for (const entry of scannedIcons) {
		const variantKey = entry.name

		const { baseName, callSiteOverrides } = parseVariantKey(variantKey)
		let [prefix, iconName] = baseName.split(":")
		if (!prefix || !iconName) {
			console.warn(`Skipping invalid icon name: ${variantKey}`)
			continue
		}

		// Resolve default:name → actual prefix:iconName for API fetch
		if (prefix === "default") {
			if (defaults[iconName]) {
				const resolved = defaults[iconName]
				const [resolvedPrefix, resolvedName] = resolved.split(":")
				prefix = resolvedPrefix
				iconName = resolvedName
			} else if (defaultSet) {
				prefix = defaultSet
			} else {
				console.warn(`Skipping default icon with no mapping or default_set: ${variantKey}`)
				continue
			}
		}

		// 3-layer style cascade: set defaults → per-icon overrides → call-site overrides
		const resolvedName = `${prefix}:${iconName}`
		const style = {
			...(setDefaults[prefix] || {}),
			...(iconOverrides[resolvedName] || {}),
			...callSiteOverrides,
		}

		if (!variants.has(variantKey)) {
			variants.set(variantKey, { name: resolvedName, prefix, iconName, style, variantKey })
		}
	}

	return [...variants.values()].sort((a, b) => a.variantKey.localeCompare(b.variantKey))
}

// --- Icon data fetching from Iconify API ---

const iconDataCache = new Map()

async function fetchIconData(prefix, iconNames) {
	const res = await fetch(`${ICONIFY_API}/${prefix}.json?icons=${iconNames.join(",")}`)
	if (!res.ok) {
		throw new Error(`Failed to fetch icons from Iconify API: ${prefix} (${res.status})`)
	}
	const data = await res.json()

	// Cache individual icon data
	for (const name of iconNames) {
		const icon = data.icons?.[name]
		if (icon) {
			// Merge with top-level defaults (width, height)
			iconDataCache.set(`${prefix}:${name}`, {
				width: icon.width || data.width || 16,
				height: icon.height || data.height || 16,
				body: icon.body,
			})
		}
	}
}

async function prefetchAllIcons(iconList) {
	// Group icons by prefix for batched API calls, skip already-cached icons
	const byPrefix = new Map()
	for (const entry of iconList) {
		if (iconDataCache.has(`${entry.prefix}:${entry.iconName}`)) continue
		if (!byPrefix.has(entry.prefix)) byPrefix.set(entry.prefix, new Set())
		byPrefix.get(entry.prefix).add(entry.iconName)
	}

	for (const [prefix, names] of byPrefix) {
		await fetchIconData(prefix, [...names])
	}
}

function getIconData(prefix, iconName) {
	return iconDataCache.get(`${prefix}:${iconName}`) || null
}

// --- Luau generation ---

function generateLuau(iconList, targets) {
	const targetEntries = []

	for (const [targetName, targetConfig] of Object.entries(targets)) {
		const { tileSize, columns } = targetConfig
		const maxCols = Math.min(columns, Math.floor(MAX_RESOLUTION / tileSize))
		const maxRows = Math.floor(MAX_RESOLUTION / tileSize)
		const maxPerSheet = maxCols * maxRows

		const iconEntries = iconList
			.map((entry, i) => {
				const sheet = Math.floor(i / maxPerSheet) + 1
				const indexInSheet = i % maxPerSheet
				return `\t\t\t["${entry.variantKey}"] = { ${sheet}, ${indexInSheet} },`
			})
			.join("\n")

		targetEntries.push(`\t${targetName} = {
\t\ttile = ${tileSize},
\t\tcolumns = ${maxCols},
\t\ticons = {
${iconEntries}
\t\t},
\t},`)
	}

	return `-- @generated by rbx-iconify
local INDEX = {
${targetEntries.join("\n")}
}

local function iconify(name: string, target: string)
\tlocal data = INDEX[target]
\tlocal entry = data.icons[name]
\tlocal col = entry[2] % data.columns
\tlocal row = math.floor(entry[2] / data.columns)
\treturn {
\t\tsheet = entry[1],
\t\toffset = Vector2.new(col * data.tile, row * data.tile),
\t\tsize = Vector2.new(data.tile, data.tile),
\t}
end

return iconify
`
}

// --- Render icons and generate sprite sheets per target ---

// resvg ships as WASM so compiled single-file binaries need no native modules.
// In a bun-compiled binary there is no node_modules, so the .wasm is embedded
// at build time (file loader) and require.resolve is the dev/Node path.
async function loadResvgWasm() {
	if (typeof Bun !== "undefined" && Bun.main.includes("$bunfs")) {
		const { default: embeddedPath } = await import("@resvg/resvg-wasm/index_bg.wasm")
		return readFileSync(embeddedPath)
	}
	const require = createRequire(import.meta.url)
	return readFileSync(require.resolve("@resvg/resvg-wasm/index_bg.wasm"))
}

await initWasm(await loadResvgWasm())

function renderIcon(entry, tileSize) {
	const iconData = getIconData(entry.prefix, entry.iconName)

	if (!iconData) {
		throw new Error(`Icon "${entry.name}" not found in Iconify API`)
	}

	const renderData = iconToSVG(iconData, { height: tileSize })

	// Force white so runtime can tint via ImageColor3
	let svgBody = replaceIDs(renderData.body).replaceAll("currentColor", "white")

	// Replace inline stroke-width on path elements (inheriting from <svg> doesn't override inline attrs)
	const strokeWidth = entry.style.stroke_width || entry.style.strokeWidth
	if (strokeWidth) {
		svgBody = svgBody.replace(/stroke-width="[^"]*"/g, `stroke-width="${strokeWidth}"`)
	}

	const attrs = renderData.attributes
	const svgAttrs = Object.entries({ ...attrs, width: tileSize, height: tileSize })
		.map(([k, v]) => `${k}="${v}"`)
		.join(" ")
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" ${svgAttrs} color="white">${svgBody}</svg>`

	// Explicit width/height above means resvg renders at exactly tileSize x tileSize
	return new Resvg(svg).render().pixels
}

function generateSpriteSheets(iconList, config) {
	for (const [targetName, targetConfig] of Object.entries(config.targets)) {
		const { tileSize, columns } = targetConfig
		const maxCols = Math.min(columns, Math.floor(MAX_RESOLUTION / tileSize))
		const maxRows = Math.floor(MAX_RESOLUTION / tileSize)
		const maxPerSheet = maxCols * maxRows

		console.log(`\nTarget: ${targetName} (${tileSize}px, ${maxCols} cols)`)

		const tiles = []
		for (const entry of iconList) {
			console.log(`  ${entry.variantKey}`)
			tiles.push(renderIcon(entry, tileSize))
		}

		const sheetDir = join(ROOT, config.sheetsDir, targetName)
		mkdirSync(sheetDir, { recursive: true })

		// The generator owns this dir — drop sheets left over from a larger icon set
		for (const file of readdirSync(sheetDir)) {
			if (/^\d+\.png$/.test(file)) unlinkSync(join(sheetDir, file))
		}

		const totalSheets = Math.ceil(tiles.length / maxPerSheet)
		for (let s = 0; s < totalSheets; s++) {
			const sheetTiles = tiles.slice(s * maxPerSheet, (s + 1) * maxPerSheet)
			const rows = Math.ceil(sheetTiles.length / maxCols)
			const sheetWidth = maxCols * tileSize
			const sheetHeight = rows * tileSize

			const sheet = new PNG({ width: sheetWidth, height: sheetHeight })
			for (let i = 0; i < sheetTiles.length; i++) {
				const left = (i % maxCols) * tileSize
				const top = Math.floor(i / maxCols) * tileSize
				const tile = sheetTiles[i]
				for (let y = 0; y < tileSize; y++) {
					const src = y * tileSize * 4
					const dst = ((top + y) * sheetWidth + left) * 4
					sheet.data.set(tile.subarray(src, src + tileSize * 4), dst)
				}
			}

			const outPath = join(sheetDir, `${s + 1}.png`)
			writeFileSync(outPath, PNG.sync.write(sheet))
			console.log(`  Wrote: ${outPath} (${sheetWidth}x${sheetHeight})`)
		}
	}
}

// --- Main ---

const ROOT = process.cwd()

const tomlPath = join(ROOT, "iconify.toml")
const config = parseConfig(readFileSync(tomlPath, "utf8"))
const outputPath = join(ROOT, config.indexPath)

let prefixes = null
let previousIconSetKey = null

async function run() {
	if (!prefixes) {
		console.log("Fetching known icon prefixes...")
		prefixes = await fetchPrefixes()
	}

	console.log("Scanning source files...")
	const scannedIcons = scanSourceFiles(ROOT, prefixes, config)
	const iconList = buildIconList(scannedIcons, config)

	if (iconList.length === 0) {
		console.log("No icons found. Nothing to generate.")
		return
	}

	// Skip regeneration if the icon set hasn't changed
	const iconSetKey = iconList.map((e) => e.variantKey).join("\n")
	if (iconSetKey === previousIconSetKey) {
		console.log("Icon set unchanged, skipping regeneration.")
		return
	}
	previousIconSetKey = iconSetKey

	console.log(`Found ${iconList.length} icon variant(s). Fetching icon data...`)

	await prefetchAllIcons(iconList)
	generateSpriteSheets(iconList, config)

	const luauSource = generateLuau(iconList, config.targets)
	mkdirSync(dirname(outputPath), { recursive: true })
	writeFileSync(outputPath, luauSource)
	console.log(`\nWrote Luau metadata: ${outputPath}`)
	console.log("Done!")
}

await run()

if (WATCH_MODE) {
	console.log("\nWatching for changes... (config changes require restart)")

	let debounceTimer = null

	function onChange(_eventType, filename) {
		if (filename && !filename.endsWith(".luau")) return
		if (filename && join(ROOT, filename) === outputPath) return

		if (debounceTimer) clearTimeout(debounceTimer)
		debounceTimer = setTimeout(async () => {
			console.log(`\n--- Change detected${filename ? `: ${filename}` : ""} ---`)
			try {
				await run()
			} catch (err) {
				console.error(`Error: ${err.message}`)
			}
		}, 200)
	}

	// Derive watch directories from scan globs
	if (config.scan) {
		const watchDirs = new Set()
		for (const pattern of config.scan) {
			const base = pattern.split("/").find((seg) => !seg.includes("*"))
			if (base) watchDirs.add(join(ROOT, base))
		}
		for (const dir of watchDirs) {
			watch(dir, { recursive: true }, onChange)
			console.log(`  Watching: ${dir}`)
		}
	} else {
		watch(ROOT, { recursive: true }, onChange)
		console.log(`  Watching: ${ROOT}`)
	}
}
