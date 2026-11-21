import { assert, test } from 'orca/testing'
import { collectRemote, isValidHost, sshArgs } from './ssh'

test('accepts only plain SSH aliases', () => {
  assert.equal(isValidHost('macbook2015'), true)
  assert.equal(isValidHost('macbook-2015.local'), true)
  assert.equal(isValidHost('build_box'), true)
  assert.equal(isValidHost(''), false)
  assert.equal(isValidHost('-oProxyCommand=bad'), false)
  assert.equal(isValidHost('host name'), false)
  assert.equal(isValidHost('host;rm -rf /'), false)
  assert.equal(isValidHost('user@host'), false)
})

test('uses non-interactive SSH options and the host before the command', () => {
  const args = sshArgs('macbook2015')
  assert.ok(args.includes('BatchMode=yes'))
  assert.ok(args.includes('ConnectTimeout=5'))
  assert.equal(args.at(-3), 'macbook2015')
  assert.deepEqual(args.slice(-2), ['/bin/sh', '-s'])
})

test('refuses an invalid host before spawning SSH', async () => {
  const controller = new AbortController()
  await assert.rejects(
    collectRemote('-oProxyCommand=bad', controller.signal),
    (error: unknown) => error instanceof Error && 'code' in error && error.code === 'host-invalid'
  )
})
