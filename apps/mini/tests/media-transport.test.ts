import test, { before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import type { UploadIntent, UploadItem } from '../src/services/types'

// No server is contacted: the real multipart parser validates the body handed to uni.
const MAX_BYTES = 10 * 1024 * 1024
const MEDIA_ID = '36f5d7fc-c070-43bf-80b7-81e0378e382e'
const PRIVATE_PATH = 'wxfile://private-child-photo-do-not-disclose.png'
const PRIVATE_TOKEN = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcdefg'
const png = new Uint8Array(readFileSync(new URL('./fixtures/avatar.png', import.meta.url)))
const jpeg = new Uint8Array(Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABBQJ//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPwF//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPwF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAGPwJ//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPyF//9oADAMBAAIAAwAAABD/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/EH//xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/EH//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/EH//2Q==', 'base64'))
const binary = (value: Uint8Array): ArrayBuffer => value.slice().buffer as ArrayBuffer
let transport: typeof import('../src/services/media-transport')
let apiBase: string
let fileBytes: ArrayBuffer
let reads: any[]
let requests: any[]
let uploads: any[]
let readHandler: (options: any) => void
let requestHandler: (options: any) => void
let uploadHandler: (options: any) => void
const uniMock: Record<string, any> = {
  getStorageSync: () => undefined,
  $emit: () => {},
  $on: () => {},
  request(options: any) { requests.push(options); requestHandler(options); return { abort() {} } },
  uploadFile(options: any) {
    uploads.push(options); uploadHandler(options)
    return { abort() {}, onProgressUpdate() {} }
  },
}

function installFileSystem() {
  uniMock.getFileSystemManager = () => ({ readFile(options: any) { reads.push(options); readHandler(options) } })
}
function intent(changes: Partial<UploadIntent> = {}): UploadIntent {
  return {
    mediaId: MEDIA_ID, uploadUrl: `${apiBase}/media/uploads/${PRIVATE_TOKEN}`,
    uploadMethod: 'POST', formFieldName: 'file', formData: {}, requiredHeaders: {},
    expiresAt: new Date(Date.now() + 600_000).toISOString(), maxBytes: MAX_BYTES, ...changes,
  }
}
function item(): UploadItem {
  return { localId: 'local-image', localPath: PRIVATE_PATH, name: 'private-family-name.png', status: 'UPLOADING', progress: 0, mediaId: MEDIA_ID }
}
function envelope(mediaId = MEDIA_ID) { return { data: { uploaded: true, mediaId } } }
function assertPrivateError(error: unknown) {
  assert.ok(error instanceof Error)
  assert.ok(!error.message.includes(PRIVATE_TOKEN), 'error must not expose the upload credential')
  assert.ok(!error.message.includes(PRIVATE_PATH), 'error must not expose the local image path')
  return true
}
async function multipart(body: ArrayBuffer, contentType: string) {
  const fields = await new Response(body, { headers: { 'Content-Type': contentType } }).formData()
  assert.deepEqual([...fields.keys()], ['file'], 'exactly one file field is sent')
  const file = fields.get('file')
  assert.ok(file instanceof File)
  return file
}
function contentType(request: any): string {
  const header = Object.entries(request.header || {}).find(([key]) => key.toLowerCase() === 'content-type')?.[1]
  assert.equal(typeof header, 'string')
  return header as string
}

before(async () => {
  ;(globalThis as any).uni = uniMock
  transport = await import('../src/services/media-transport')
  apiBase = (await import('../src/services/api')).API_BASE
})
beforeEach(() => {
  fileBytes = binary(png); reads = []; requests = []; uploads = []
  readHandler = options => options.success({ data: fileBytes })
  requestHandler = options => options.success({ statusCode: 200, data: envelope() })
  uploadHandler = options => options.success({ statusCode: 200, data: JSON.stringify(envelope()) })
  installFileSystem()
})

for (const [mime, bytes, extension] of [['image/png', png, 'png'], ['image/jpeg', jpeg, 'jpe?g']] as const) {
  test(`multipart round-trips ${mime} bytes with a real form-data parser`, async () => {
    const boundary = 'pointjoy-safe-test-boundary-847293'
    const original = binary(bytes)
    const body = transport.encodeMultipartImage(original, mime, boundary)
    assert.ok(body instanceof ArrayBuffer)
    const file = await multipart(body, `multipart/form-data; boundary=${boundary}`)
    assert.equal(file.type, mime)
    assert.match(file.name, new RegExp(`^(avatar|image)\\.${extension}$`))
    assert.deepEqual(new Uint8Array(await file.arrayBuffer()), bytes)
    assert.deepEqual(new Uint8Array(original), bytes, 'encoder does not modify its input')
    const raw = Buffer.from(body)
    assert.ok(raw.subarray(0, boundary.length + 4).equals(Buffer.from(`--${boundary}\r\n`)))
    assert.ok(raw.subarray(-boundary.length - 8).equals(Buffer.from(`\r\n--${boundary}--\r\n`)), 'closing delimiter is complete and CRLF terminated')
    const headerEnd = raw.indexOf('\r\n\r\n')
    assert.ok(headerEnd > 0)
    assert.match(raw.subarray(0, headerEnd).toString('ascii'), /Content-Disposition: form-data; name="file"; filename="/i)
    assert.ok(!raw.subarray(0, headerEnd).toString('ascii').replaceAll('\r\n', '').includes('\n'))
  })
}

test('WeChat reads binary without encoding and sends POST ArrayBuffer through request', async () => {
  const image = item()
  await transport.sendImageFile(intent({ requiredHeaders: { 'X-Upload-Test': 'preserved' } }), image, 'image/png', png.byteLength)
  assert.equal(image.progress, 100)
  assert.equal(reads.length, 1)
  assert.equal(reads[0].filePath, PRIVATE_PATH)
  assert.equal(reads[0].encoding, undefined)
  assert.equal(requests.length, 1)
  assert.equal(uploads.length, 0, 'native uploadFile must not be used on the FS path')
  assert.equal(requests[0].method, 'POST')
  assert.equal(requests[0].url, intent().uploadUrl)
  assert.equal(requests[0].header['X-Upload-Test'], 'preserved')
  assert.ok(requests[0].data instanceof ArrayBuffer)
  const file = await multipart(requests[0].data, contentType(requests[0]))
  assert.deepEqual(new Uint8Array(await file.arrayBuffer()), png)
  assert.ok(!file.name.includes('private-family-name'))
})

test('exactly 10 MiB is accepted and a larger advertised file is rejected before transfer', async () => {
  fileBytes = new ArrayBuffer(MAX_BYTES)
  await transport.sendImageFile(intent(), item(), 'image/png', MAX_BYTES)
  assert.equal(requests.length, 1)
  requests = []; uploads = []
  await assert.rejects(transport.sendImageFile(intent(), item(), 'image/png', MAX_BYTES + 1), /10\s*MiB|过大|超过/)
  assert.equal(requests.length + uploads.length, 0)
})

test('actual oversized bytes cannot bypass the size gate using a smaller advertised size', async () => {
  fileBytes = new ArrayBuffer(MAX_BYTES + 1)
  await assert.rejects(transport.sendImageFile(intent(), item(), 'image/png', png.byteLength), assertPrivateError)
  assert.equal(requests.length + uploads.length, 0)
})

test('changed local file size is rejected before any transfer', async () => {
  fileBytes = new ArrayBuffer(png.byteLength + 1)
  await assert.rejects(transport.sendImageFile(intent(), item(), 'image/png', png.byteLength), assertPrivateError)
  assert.equal(requests.length + uploads.length, 0)
})

for (const [label, url] of [
  ['different origin', () => `https://uploads.example.invalid/api/v1/media/uploads/${PRIVATE_TOKEN}`],
  ['same origin but unrelated API route', () => `${apiBase}/auth/login`],
  ['missing upload token', () => `${apiBase}/media/uploads/`],
] as const) {
  test(`rejects ${label} before transfer`, async () => {
    await assert.rejects(transport.sendImageFile(intent({ uploadUrl: url() }), item(), 'image/png', png.byteLength), assertPrivateError)
    assert.equal(requests.length + uploads.length, 0)
  })
}

test('readFile failure neither transfers nor falls back to a second transport', async () => {
  readHandler = options => options.fail({ errMsg: `readFile:fail ${PRIVATE_PATH}` })
  await assert.rejects(transport.sendImageFile(intent(), item(), 'image/png', png.byteLength), assertPrivateError)
  assert.equal(requests.length + uploads.length, 0)
})

test('readFile returning a string is rejected instead of corrupting binary contents', async () => {
  readHandler = options => options.success({ data: 'not-an-arraybuffer' })
  await assert.rejects(transport.sendImageFile(intent(), item(), 'image/png', png.byteLength), assertPrivateError)
  assert.equal(requests.length + uploads.length, 0)
})

for (const [label, response] of [
  ['uploaded false', { data: { uploaded: false, mediaId: MEDIA_ID } }],
  ['another media ID', envelope('45e270d2-bfcf-4863-a16b-df62bc2a92bc')],
  ['missing envelope', { uploaded: true, mediaId: MEDIA_ID }],
  ['non-JSON text', '<html>upstream unavailable</html>'],
] as const) {
  test(`HTTP 200 with ${label} does not mean upload succeeded`, async () => {
    requestHandler = options => options.success({ statusCode: 200, data: response })
    await assert.rejects(transport.sendImageFile(intent(), item(), 'image/png', png.byteLength), assertPrivateError)
    assert.equal(requests.length, 1, 'an uncertain result must not be automatically resent')
    assert.equal(uploads.length, 0)
  })
}

test('expired intent returns an actionable 410 error without exposing upload URL', async () => {
  requestHandler = options => options.success({ statusCode: 410, data: { error: { message: `${PRIVATE_TOKEN} ${PRIVATE_PATH}` } } })
  await assert.rejects(transport.sendImageFile(intent(), item(), 'image/png', png.byteLength), error => {
    assertPrivateError(error); assert.match((error as Error).message, /过期|失效/); return true
  })
  assert.equal(requests.length, 1)
  assert.equal(uploads.length, 0)
})

test('network failure suggests retry without automatically repeating transfer or leaking SDK errors', async () => {
  requestHandler = options => options.fail({ errMsg: `request:fail ${intent().uploadUrl} ${PRIVATE_PATH}` })
  await assert.rejects(transport.sendImageFile(intent(), item(), 'image/png', png.byteLength), error => {
    assertPrivateError(error); assert.equal((error as { code: string }).code, 'MEDIA_NETWORK_FAILED'); assert.match((error as Error).message, /网络|中断/); assert.match((error as Error).message, /重试|重新/); return true
  })
  assert.equal(requests.length, 1)
  assert.equal(uploads.length, 0)
})

test('request timeout is distinguishable and does not repeat a potentially accepted upload', async () => {
  requestHandler = options => options.fail({ errMsg: `request:fail timeout ${intent().uploadUrl}` })
  await assert.rejects(transport.sendImageFile(intent(), item(), 'image/png', png.byteLength), error => {
    assertPrivateError(error)
    assert.equal((error as { code: string }).code, 'MEDIA_TIMEOUT')
    assert.match((error as Error).message, /超时/)
    assert.match((error as Error).message, /重试/)
    return true
  })
  assert.equal(requests.length, 1)
  assert.equal(uploads.length, 0)
})

test('HTTP 500 is not retried or mistaken for a successful upload', async () => {
  requestHandler = options => options.success({ statusCode: 500, data: envelope() })
  await assert.rejects(transport.sendImageFile(intent(), item(), 'image/png', png.byteLength), assertPrivateError)
  assert.equal(requests.length, 1)
  assert.equal(uploads.length, 0)
})

test('without filesystem support, H5 uploadFile accepts a matching JSON success envelope', async () => {
  delete uniMock.getFileSystemManager
  const image = item()
  await transport.sendImageFile(intent(), image, 'image/png', png.byteLength)
  assert.equal(image.progress, 100)
  assert.equal(requests.length, 0)
  assert.equal(uploads.length, 1)
  assert.equal(uploads[0].url, intent().uploadUrl)
  assert.equal(uploads[0].filePath, PRIVATE_PATH)
  assert.equal(uploads[0].name, 'file')
})

test('H5 fallback also validates response media ID and never retries automatically', async () => {
  delete uniMock.getFileSystemManager
  uploadHandler = options => options.success({ statusCode: 200, data: JSON.stringify(envelope('wrong-media')) })
  await assert.rejects(transport.sendImageFile(intent(), item(), 'image/png', png.byteLength), assertPrivateError)
  assert.equal(uploads.length, 1)
  assert.equal(requests.length, 0)
})
