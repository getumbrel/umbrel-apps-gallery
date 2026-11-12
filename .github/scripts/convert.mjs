#!/usr/bin/env node
// Generates derived images for the Umbrel apps gallery.
//
//   <app>/icon.svg            -> <app>/icon.png  (256x256)
//   <app>/<name>.jpg|jpeg|png -> <app>/<name>.webp (same dimensions)
//
// Originals are never modified or removed. Every input is treated as untrusted:
// SVGs are checked before rendering, and each file is converted in its own
// child process with a hard timeout.
//
// Usage:
//   node convert.mjs --root <gallery> [--out <dir>] --all            convert what is missing
//   node convert.mjs --root <gallery> [--out <dir>] --files <list>   convert the listed sources (overwrite)
//
// <list> is a text file with one path per line, relative to --root.

import {execFile} from 'node:child_process'
import {readFile, writeFile, mkdir, readdir, stat, rename, rm} from 'node:fs/promises'
import {existsSync} from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {fileURLToPath} from 'node:url'

const ICON_SIZE = 256
const WEBP_QUALITY = 80
const MAX_INPUT_BYTES = 5 * 1024 * 1024
const MAX_INPUT_PIXELS = 50_000_000
const FILE_TIMEOUT_MS = 30_000
const APP_ID = /^[a-z0-9][a-z0-9-]*$/
const GALLERY_SOURCE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.(jpe?g|png)$/i
const ALLOWED_DATA_URI = /^data:image\/(png|jpe?g|gif|webp)[;,]/i

// --- SVG safety check -------------------------------------------------------

// Returns a reason string when the SVG must not be rendered, otherwise null.
export function svgRejectionReason(svg) {
	if (/<!DOCTYPE[^>]*\[/i.test(svg) || /<!ENTITY/i.test(svg)) return 'declares entities'
	if (/<\?xml-stylesheet/i.test(svg)) return 'references an external stylesheet'
	if (/<\s*script[\s>/]/i.test(svg)) return 'contains a script'
	if (/<\s*foreignObject[\s>/]/i.test(svg)) return 'contains foreignObject'
	if (/<\s*(\w+:)?include[\s>/]/i.test(svg)) return 'contains an include'
	if (/@import/i.test(svg)) return 'imports a stylesheet'

	// Every link must be an internal reference or an embedded raster image.
	const links = svg.matchAll(/\b(?:xlink:href|href|src)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)
	for (const match of links) {
		const value = (match[1] ?? match[2]).trim()
		if (value.startsWith('#') || ALLOWED_DATA_URI.test(value)) continue
		return `links to an external resource (${value.slice(0, 40)})`
	}
	const urls = svg.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\)/gi)
	for (const match of urls) {
		const value = (match[1] ?? match[2] ?? match[3]).replaceAll('&quot;', '').replaceAll('&apos;', '').trim()
		if (value.startsWith('#') || ALLOWED_DATA_URI.test(value)) continue
		return `links to an external resource (${value.slice(0, 40)})`
	}
	return null
}

// --- Single-file conversion (runs in a child process) -----------------------

// Re-encodes every embedded raster image as a plain sRGB PNG before rendering.
// Browsers sniff the real image type and apply its colour profile, while the
// SVG renderer trusts the declared type and ignores profiles. Without this, a
// JPEG labelled as PNG renders blank and wide-gamut images look washed out.
async function normaliseEmbeddedImages(sharp, svg) {
	const pattern = /data:image\/[a-z0-9.+-]+;base64,([A-Za-z0-9+/=\s]+)/gi
	let result = ''
	let position = 0
	for (const match of svg.matchAll(pattern)) {
		const image = Buffer.from(match[1], 'base64')
		const png = await sharp(image, {limitInputPixels: MAX_INPUT_PIXELS}).png({compressionLevel: 1}).toBuffer()
		result += svg.slice(position, match.index) + 'data:image/png;base64,' + png.toString('base64')
		position = match.index + match[0].length
	}
	return result + svg.slice(position)
}

async function convertOne(source, destination) {
	const {default: sharp} = await import('sharp')
	sharp.cache(false)
	sharp.concurrency(1)

	const input = await readFile(source)
	if (input.length > MAX_INPUT_BYTES) throw new Error(`is larger than ${MAX_INPUT_BYTES} bytes`)

	let output
	if (source.toLowerCase().endsWith('.svg')) {
		const reason = svgRejectionReason(input.toString('utf8'))
		if (reason) throw new Error(reason)
		const svg = Buffer.from(await normaliseEmbeddedImages(sharp, input.toString('utf8')))
		// Render the vector at the target size instead of scaling a small bitmap.
		const {width, height} = await sharp(svg, {limitInputPixels: MAX_INPUT_PIXELS}).metadata()
		if (!width || !height) throw new Error('has no usable size')
		const density = Math.min(2400, Math.max(1, Math.ceil((72 * ICON_SIZE) / Math.min(width, height))))
		output = await sharp(svg, {density, limitInputPixels: MAX_INPUT_PIXELS})
			.resize(ICON_SIZE, ICON_SIZE, {fit: 'contain', background: {r: 0, g: 0, b: 0, alpha: 0}})
			.png({compressionLevel: 9, effort: 10})
			.toBuffer()
	} else {
		// Trust the file signature, not the extension, so nothing but a real JPEG
		// or PNG reaches the decoder (an SVG named .jpg would otherwise be rendered).
		const isJpeg = input.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))
		const isPng = input.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
		const expectsPng = source.toLowerCase().endsWith('.png')
		if (expectsPng ? !isPng : !isJpeg) throw new Error('is not a real JPEG or PNG file')
		output = await sharp(input, {limitInputPixels: MAX_INPUT_PIXELS})
			.rotate() // apply any EXIF orientation, then drop metadata
			.webp({quality: WEBP_QUALITY, effort: 6})
			.toBuffer()
	}

	await mkdir(path.dirname(destination), {recursive: true})
	const temporary = `${destination}.tmp-${process.pid}`
	await writeFile(temporary, output)
	await rename(temporary, destination)
}

// --- Planning ---------------------------------------------------------------

function destinationFor(relativeSource) {
	const [app, file, ...rest] = relativeSource.split('/')
	if (rest.length > 0 || !file || !APP_ID.test(app)) return null
	if (file === 'icon.svg') return `${app}/icon.png`
	if (file.toLowerCase().startsWith('icon.')) return null
	if (GALLERY_SOURCE.test(file)) return `${app}/${file.replace(/\.[^.]+$/, '')}.webp`
	return null
}

async function listAllSources(root) {
	const sources = []
	for (const app of (await readdir(root)).sort()) {
		if (!APP_ID.test(app)) continue
		const directory = path.join(root, app)
		if (!(await stat(directory)).isDirectory()) continue
		for (const file of (await readdir(directory)).sort()) sources.push(`${app}/${file}`)
	}
	return sources
}

function runChild(source, destination) {
	return new Promise((resolve) => {
		execFile(
			process.execPath,
			[fileURLToPath(import.meta.url), '--one', source, destination],
			{timeout: FILE_TIMEOUT_MS, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024},
			(error, _stdout, stderr) => {
				if (!error) return resolve(null)
				if (error.killed) return resolve(`timed out after ${FILE_TIMEOUT_MS / 1000}s`)
				resolve(stderr.trim().split('\n').pop() || error.message)
			},
		)
	})
}

async function main() {
	const args = process.argv.slice(2)
	if (args[0] === '--one') {
		try {
			await convertOne(args[1], args[2])
		} catch (error) {
			console.error(error.message)
			process.exit(1)
		}
		return
	}

	const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)
	const root = path.resolve(option('--root') ?? '.')
	const out = path.resolve(option('--out') ?? root)
	const listFile = option('--files')
	const all = args.includes('--all')
	if (all === Boolean(listFile)) {
		console.error('Pass exactly one of --all or --files <list>')
		process.exit(2)
	}

	const candidates = all
		? await listAllSources(root)
		: (await readFile(listFile, 'utf8')).split('\n').map((line) => line.trim()).filter(Boolean)

	// Build the job list, refusing two sources that would write the same file.
	const jobs = new Map()
	const failures = []
	for (const source of candidates) {
		const destination = destinationFor(source)
		if (!destination) continue
		if (!existsSync(path.join(root, source))) continue // deleted in this push
		if (all && existsSync(path.join(root, destination))) continue // already generated
		if (jobs.has(destination)) {
			failures.push(`${source}: would overwrite the output of ${jobs.get(destination)}`)
			continue
		}
		jobs.set(destination, source)
	}

	const queue = [...jobs.entries()]
	let converted = 0
	const worker = async () => {
		for (let job = queue.shift(); job; job = queue.shift()) {
			const [destination, source] = job
			const target = path.join(out, destination)
			const failure = await runChild(path.join(root, source), target)
			if (failure) {
				failures.push(`${source}: ${failure}`)
				await rm(target, {force: true})
			} else {
				converted++
				console.log(`${source} -> ${destination}`)
			}
		}
	}
	await Promise.all(Array.from({length: Math.max(1, os.availableParallelism())}, worker))

	console.log(`\nConverted ${converted} file(s), ${failures.length} failure(s).`)
	for (const failure of failures.sort()) console.error(`FAILED ${failure}`)
	process.exit(failures.length > 0 ? 1 : 0)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
