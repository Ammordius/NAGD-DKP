import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { safeNextPath } from './safeNextPath.js'

describe('safeNextPath', () => {
  it('keeps an in-app path and query', () => {
    assert.equal(safeNextPath('/'), '/')
    assert.equal(safeNextPath('/accounts/abc?tab=history'), '/accounts/abc?tab=history')
    assert.equal(safeNextPath('/items/Foo%20Bar'), '/items/Foo%20Bar')
  })

  it('rejects missing values and off-site targets', () => {
    for (const value of [null, undefined, '', 12, 'https://evil.example', 'javascript:alert(1)', '//evil.example', '\\\\evil.example']) {
      assert.equal(safeNextPath(value), '/')
    }
  })

  it('rejects backslash open-redirect bypasses', () => {
    for (const value of ['/\\evil.example', '/\\\\evil.example', '/foo\\bar', '/%5Cevil.example', '/%5cevil.example', '/%2f%2fevil.example', '/foo%2F%2Fbar']) {
      assert.equal(safeNextPath(value), '/')
    }
  })

  it('rejects control characters', () => {
    assert.equal(safeNextPath('/foo\n//evil.example'), '/')
    assert.equal(safeNextPath('/foo\tbar'), '/')
  })
})
