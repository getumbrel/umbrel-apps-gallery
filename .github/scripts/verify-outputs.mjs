#!/usr/bin/env node
// Copies generated images from an untrusted build artifact into the repository.
//
// This runs in the job that can write to the repository, so it does not decode
// any image. It only accepts a file when its path, type and size are exactly
// what the conversion job is supposed to produce, and when the source image it
// was generated from exists in the repository.
//
// Usage: node verify-outputs.mjs <artifact dir> <repository dir>

import {readdir, lstat, open, copyFile} from 'node:fs/promises'
import {existsSync} from 'node:fs'
import path from 'node:path'

const [artifact, repository] = process.argv.slice(2).map((directory) => path.resolve(directory))
const APP_ID = /^[a-z0-9][a-z0-9-]*$/
const WEBP_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\.webp$/
const MAX_BYTES = 5 * 1024 * 1024
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

async function firstBytes(file, length) {
	const handle = await open(file, 'r')
	try {
		const buffer = Buffer.alloc(length)
		await handle.read(buffer, 0, length, 0)
		return buffer
	} finally {
		await handle.close()
	}
}

async function check(app, file) {
	const source = path.join(artifact, app, file)
	const info = await lstat(source)
	if (!info.isFile()) return 'is not a regular file'
	if (info.size === 0 || info.size > MAX_BYTES) return `has an unexpected size (${info.size} bytes)`
	if (!existsSync(path.join(repository, app))) return 'belongs to an app that is not in the repository'
	const header = await firstBytes(source, 12)

	if (file === 'icon.png') {
		if (!header.subarray(0, 8).equals(PNG_SIGNATURE)) return 'is not a PNG'
		if (!existsSync(path.join(repository, app, 'icon.svg'))) return 'has no icon.svg to come from'
		return null
	}
	if (WEBP_NAME.test(file) && !file.toLowerCase().startsWith('icon.')) {
		const isWebp = header.subarray(0, 4).toString('latin1') === 'RIFF' && header.subarray(8, 12).toString('latin1') === 'WEBP'
		if (!isWebp) return 'is not a WebP'
		const base = file.slice(0, -'.webp'.length)
		const hasSource = (await readdir(path.join(repository, app))).some((name) => {
			const match = name.match(/^(.*)\.(jpe?g|png)$/i)
			return match && match[1] === base
		})
		if (!hasSource) return 'has no JPEG or PNG to come from'
		return null
	}
	return 'has an unexpected name'
}

const accepted = []
const rejected = []
if (existsSync(artifact)) {
	for (const app of await readdir(artifact)) {
		const directory = path.join(artifact, app)
		if (!APP_ID.test(app) || !(await lstat(directory)).isDirectory()) {
			rejected.push(`${app}: is not an app folder`)
			continue
		}
		for (const file of await readdir(directory)) {
			const reason = await check(app, file)
			if (reason) rejected.push(`${app}/${file}: ${reason}`)
			else accepted.push(`${app}/${file}`)
		}
	}
}

// One bad file means the artifact cannot be trusted, so nothing is copied.
if (rejected.length > 0) {
	for (const line of rejected) console.error(`REJECTED ${line}`)
	process.exit(1)
}
for (const file of accepted) {
	await copyFile(path.join(artifact, file), path.join(repository, file))
	console.log(file)
}
