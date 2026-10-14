import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/BDH_D39304_US'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device, buf } from '@/tests/helpers/mocks'

const DEVICE_ID = 'test-id'
const MODEL_ID = 'BDH_D39304_US'
const META: Metadata = { modelId: MODEL_ID, modelName: MODEL_ID, swVersion: '2.11.263' }

// A real 0xEB frame from a WashTower WKHC252HWA dryer seconds after starting Normal at the panel.
const NORMAL_DRYING = buf(
    'aaff340a003c00097e000100eb002a00030200000700000000410041070e0002000104070000920000418007000000000000000000000000001fb6bb',
)

function feed(frames: Buffer[]) {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(DEVICE_ID, META)
    new DUT(ha.asConnection(), thinq, META)
    for (const f of frames) thinq.emit('data', f)
    return ha.devices[DEVICE_ID].properties
}

describe('BDH_D39304_US', () => {
    test('decodes with the BDH_D30007_US layout under class byte 0x34', () => {
        const p = feed([NORMAL_DRYING])
        assert.equal(p.power, 'ON')
        assert.equal(p.status, 'Drying')
        assert.equal(p.course, 'Normal')
        assert.equal(p.dry_level, 'Iron')
        assert.equal(p.eco_hybrid, 'Normal')
        assert.equal(p.remaining_time, 65)
        assert.equal(p.initial_time, 65)
        assert.equal(p.remote_start, 'ON')
    })

    test('the washer half of the same module is ignored', () => {
        const washer = buf(
            'aaff330a0045000981000100eb003300030e0e0e1600000000000000002d002d000000000b24900700000232040000000000000000000020000000000000040000002f7dbb',
        )
        const ha = new MockHAConnection()
        const thinq = new MockThinq2Device(DEVICE_ID, META)
        new DUT(ha.asConnection(), thinq, META)
        thinq.emit('data', washer)
        assert.equal(ha.devices[DEVICE_ID]?.properties.status, undefined)
    })
})
