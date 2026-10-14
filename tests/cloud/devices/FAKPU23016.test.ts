import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/FAKPU23016'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device, buf } from '@/tests/helpers/mocks'

const DEVICE_ID = 'test-id'
const MODEL_ID = 'FAKPU23016'
const META: Metadata = { modelId: MODEL_ID, modelName: MODEL_ID, swVersion: '2.11.266' }

// Real 0xEB frames captured from a WashTower WKHC252HWA washer with rethink-capture. Not paired with
// LG's cloud: the expectations are what was selected at the panel and what the machine visibly did.

// Normal, hottest temperature, Pre-Wash and Extra Rinse, a few seconds after Start: Running, 82 min.
const HOT_START = buf(
    'aaff330a00450001e8000100eb00330003130f0f2e0000000000000000520052000000000b0390010000023104000000006000001000402100000000000004000000afa9bb',
)
// 16 minutes in: the pre-wash has finished (rec[34] 0x60 -> 0x20), 24 Wh used.
const PREWASH_DONE = buf(
    'aaff330a00450002d3000100eb00330003130f0f2e0000000000000000430052001800000b039001000002310400000000200000100040210000000000000400000074c3bb',
)
// Rinsing (12, previous Running 11), 685 Wh, 22 min left.
const RINSING = buf(
    'aaff330a0045000797000100eb00330000130f0f2e000000000000000016005202ad00000c0b900100000231040000000020000010004021000000000000040000008250bb',
)
// Spinning (14), the extra rinse used up (rec[39] bit 0x40 clear, rinses left 0).
const SPINNING = buf(
    'aaff330a00450008bf000100eb00330000000e0f2e000000000000000009005202d000000e0c900100000031040000000020000010000021000000000000040000002134bb',
)
// End (16): Tub Clean counter 49 -> 50, drum light on, 745 Wh.
const END = buf(
    'aaff330a0045000945000100eb00330000000e0000000000000000000001000002e90000100e90000000003204000000000000004000002000000000000004000000e373bb',
)
// Powered off after the cycle.
const OFF = buf(
    'aaff330a0045000956000100eb00330000000e0000000000000000000001000002ea0000001090000000003204000000000000004000002000000000000004000000b31abb',
)
// A second cycle, Delicates at its default settings: course code 22, temp code 14, 45 min.
const DELICATES_START = buf(
    'aaff330a0045000981000100eb003300030e0e0e1600000000000000002d002d000000000b24900700000232040000000000000000000020000000000000040000002f7dbb',
)

function feed(frames: Buffer[]) {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(DEVICE_ID, META)
    new DUT(ha.asConnection(), thinq, META)
    for (const f of frames) thinq.emit('data', f)
    return ha.devices[DEVICE_ID].properties
}

describe('FAKPU23016', () => {
    test('a started Normal cycle', () => {
        const p = feed([HOT_START])
        assert.equal(p.power, 'ON')
        assert.equal(p.status, 'Running')
        assert.equal(p.previous_status, 'Detecting')
        assert.equal(p.course, 'Normal')
        assert.equal(p.soil, 'Normal')
        assert.equal(p.spin, 'High')
        assert.equal(p.rinse, 'Plus') // Extra Rinse selected
        assert.equal(p.temp, 'code 19') // not yet mapped on this model
        assert.equal(p.remaining_time, 82)
        assert.equal(p.initial_time, 82)
        assert.equal(p.pre_wash, 'ON')
        assert.equal(p.extra_rinse, 'ON')
        assert.equal(p.turbo_wash, 'ON')
        assert.equal(p.remote_start, 'ON')
        assert.equal(p.rinses_left, 2)
        assert.equal(p.error, 'None')
    })

    test('16-bit fields are big-endian', () => {
        const p = feed([RINSING])
        assert.equal(p.energy, 0x02ad) // 685, read little-endian it would be 44290
        assert.equal(p.remaining_time, 22)
        assert.equal(p.initial_time, 82)
    })

    test('the cycle phases', () => {
        assert.equal(feed([PREWASH_DONE]).pre_wash, 'OFF')
        assert.equal(feed([RINSING]).status, 'Rinsing')
        const spin = feed([SPINNING])
        assert.equal(spin.status, 'Spinning')
        assert.equal(spin.extra_rinse, 'OFF')
        assert.equal(spin.rinses_left, 0)
        const end = feed([END])
        assert.equal(end.status, 'End')
        assert.equal(end.tub_clean_count, 50)
        assert.equal(end.drum_light, 'ON')
        assert.equal(end.energy, 745)
    })

    test('power off clears the cycle fields', () => {
        const p = feed([HOT_START, OFF])
        assert.equal(p.power, 'OFF')
        assert.equal(p.status, 'Off')
        assert.equal(p.previous_status, 'End')
        assert.equal(p.remaining_time, 0)
        assert.equal(p.course, 'None')
    })

    test('codes outside the tables stay visible', () => {
        const p = feed([DELICATES_START])
        assert.equal(p.course, 'Delicates')
        assert.equal(p.temp, 'code 14')
        assert.equal(p.previous_status, 'Confirm start for control')
        assert.equal(p.remaining_time, 45)
    })

    test('the dryer half of the same module is ignored', () => {
        const dryer = buf(
            'aaff340a003c00097e000100eb002a00030200000700000000410041070e0002000104070000920000418007000000000000000000000000001fb6bb',
        )
        const ha = new MockHAConnection()
        const thinq = new MockThinq2Device(DEVICE_ID, META)
        new DUT(ha.asConnection(), thinq, META)
        thinq.emit('data', dryer)
        assert.equal(ha.devices[DEVICE_ID]?.properties.status, undefined)
    })
})
