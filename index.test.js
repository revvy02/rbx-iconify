import { describe, it, expect } from "vitest"
import { readFileSync, readdirSync, existsSync } from "fs"
import { join, dirname, extname } from "path"
import { fileURLToPath } from "url"
import { spawn } from "child_process"
import TOML from "@iarna/toml"
import { PNG } from "pngjs"

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixturesDir = join(__dirname, "fixtures")
const indexPath = join(__dirname, "index.js")

const MAX_RESOLUTION = 4096

function runIconify(fixtureDir) {
	return new Promise((resolve, reject) => {
		const child = spawn("node", [indexPath], {
			cwd: fixtureDir,
			stdio: ["ignore", "pipe", "pipe"],
		})

		const stdout = []
		const stderr = []
		child.stdout.on("data", (d) => stdout.push(d))
		child.stderr.on("data", (d) => stderr.push(d))

		child.on("error", reject)
		child.on("close", (exitCode) => {
			resolve({
				exitCode,
				stdout: Buffer.concat(stdout).toString(),
				stderr: Buffer.concat(stderr).toString(),
			})
		})
	})
}

// Count icon entries inside a target's icons table
function countIconEntries(luauSource, targetName) {
	// Match the icons block for the given target
	const targetRegex = new RegExp(
		`${targetName}\\s*=\\s*\\{[^}]*icons\\s*=\\s*\\{([^}]*)\\}`,
		"s"
	)
	const match = luauSource.match(targetRegex)
	if (!match) return 0
	const iconMatches = match[1].match(/\["/g)
	return iconMatches ? iconMatches.length : 0
}

function sheetPath(basePath, sheetNum) {
	const ext = extname(basePath)
	const base = basePath.slice(0, -ext.length)
	return `${base}_${sheetNum}${ext}`
}

const fixtures = readdirSync(fixturesDir, { withFileTypes: true })
	.filter((d) => d.isDirectory())
	.map((d) => d.name)

describe.each(fixtures)("fixture: %s", (fixtureName) => {
	const dir = join(fixturesDir, fixtureName)

	it("generates correct Luau output and sprite sheets", async () => {
		const result = await runIconify(dir)
		expect(result.exitCode).toBe(0)

		// Verify Luau output
		const expected = readFileSync(join(dir, "expected.luau"), "utf8")
		const actual = readFileSync(join(dir, "output.luau"), "utf8")
		expect(actual).toBe(expected)

		// Verify sprite sheets per target
		const config = TOML.parse(
			readFileSync(join(dir, "iconify.toml"), "utf8")
		)

		for (const [targetName, targetConfig] of Object.entries(config.target)) {
			const tileSize = targetConfig.tile_size || 64
			const columns = targetConfig.columns || 16
			const maxCols = Math.min(columns, Math.floor(MAX_RESOLUTION / tileSize))
			const maxRows = Math.floor(MAX_RESOLUTION / tileSize)
			const maxPerSheet = maxCols * maxRows
			const iconCount = countIconEntries(expected, targetName)
			const totalSheets = Math.ceil(iconCount / maxPerSheet)

			for (let s = 1; s <= totalSheets; s++) {
				const spritePath = join(dir, sheetPath(targetConfig.path, s))
				expect(existsSync(spritePath)).toBe(true)

				const iconsOnSheet =
					s < totalSheets
						? maxPerSheet
						: iconCount - (s - 1) * maxPerSheet
				const rows = Math.ceil(iconsOnSheet / maxCols)

				const sprite = PNG.sync.read(readFileSync(spritePath))
				expect(sprite.width).toBe(maxCols * tileSize)
				expect(sprite.height).toBe(rows * tileSize)

				// Verify sprite has visible content (data is always RGBA)
				let nonTransparentPixels = 0
				for (let i = 0; i < sprite.data.length; i += 4) {
					if (sprite.data[i + 3] > 0) nonTransparentPixels++
				}
				expect(nonTransparentPixels).toBeGreaterThan(0)
			}
		}
	}, 30_000)
})
