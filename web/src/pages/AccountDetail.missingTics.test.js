import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const dir = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(dir, 'AccountDetail.jsx'), 'utf8')

describe('AccountDetail missing-tic fetch scope', () => {
  it('loads the raid universe when either missing-tic control is on', () => {
    assert.match(source, /includeMissing = Boolean\(showMissingDetails \|\| onlyMissingRaids\)/)
    assert.match(source, /fetchAccountDetail\(accountId, includeMissing\)/)
  })

  it('scopes SWR and sessionStorage keys by missing-data need', () => {
    assert.match(source, /account-detail-\$\{accountId\}\$\{includeMissing \? ':missing' : ''\}/)
    assert.match(source, /accountDetailSessionKey\(accountId, includeMissing\)/)
    assert.match(source, /getAccountDetailFromSession\(accountId, includeMissing\)/)
    assert.match(source, /setAccountDetailInSession\(accountId, data, includeMissing\)/)
  })

  it('keeps both UI controls and does not let a non-missing cache key satisfy missing', () => {
    assert.match(source, /Show missing tic details/)
    assert.match(source, /Only show raids with missing tics/)
    assert.match(source, /\$\{ACCOUNT_CACHE_KEY\}-\$\{accountId\}\$\{includeMissing \? ':missing' : ''\}/)
    assert.doesNotMatch(
      source,
      /getAccountDetailFromSession\(accountId\)\s*$/m,
    )
  })
})
