import HADevice from './base'
import { Device as Thinq2Device } from '../thinq2/device'
import { type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import AABBDevice from './aabb_device'
import { Enum } from '@/util/enum'

// LG WashTower WKHC252HWA, washer half: modelId "FAKPU23016" (thinq2 deviceType 221). It shares one
// Wi-Fi module with the dryer half (BDH_D39304_US, class byte 0x34); this half is class byte 0x33.
//
// Long AABB framing, the same envelope as FAFXU25006 (aa ff <class> 0a <len16> ... <inner type>
// <inner len16> <records> <chk16> bb), so AABBDevice.processEnvelopedStatus unwraps it. The 0xEB
// record is 51 bytes, and is sent whenever anything in it changes.
//
// The layout is the first 51 bytes of LG's washer record as decoded for the Korean WashTower washer
// (FAKPK21021, rethink PR #117) and, where they overlap, FAFXU25006. Each offset used here moved the
// way its name says across two captured cycles (Normal/Hot with Pre-Wash and Extra Rinse, and a cold
// cycle), but nothing has been cross-checked against LG's cloud. Unlike FAFXU25006, the 16-bit fields
// are big-endian: energy at rec[17:19] climbed 0x00e9 -> 0x0100 -> 0x02ea over one cycle.
//
// Inner types seen and not decoded: 0x03 (65-161 bytes; carries the model name, looks like a settings
// or capability dump, not a door event as on FAFXU25006).

const CLASS_BYTE = 0x33
const RECORD_LEN = 51

// Status query, LG's family-wide read-only "report your state" (0xF0ED), as FAFXU25006 and
// BDH_D30007_US send on connect. Without it the entities stay unknown until the next state change.
const STATUS_REQUEST = 'F0ED112101000000180411120000'

const SOIL_OFFSET = 1
const TEMP_OFFSET = 2
const RINSE_OFFSET = 3
const SPIN_OFFSET = 4
const COURSE_OFFSET = 5
const RESERVE_TIME_OFFSET = 11 // Delay Wash minutes left, per PR #117; not yet seen non-zero
const REMAIN_TIME_OFFSET = 13
const INITIAL_TIME_OFFSET = 15
const SPENT_POWER_OFFSET = 17 // assumed Wh as on FAFXU25006: 746 after a Hot cycle with Pre-Wash
const ERROR_OFFSET = 19
const STATE_OFFSET = 21
const LOAD_LEVEL_OFFSET = 24
const RINSES_LEFT_OFFSET = 27 // 2 -> 1 -> 0 through a cycle with Extra Rinse
const TUB_CLEAN_COUNT_OFFSET = 28 // went 49 -> 50 as a cycle ended
const BUZZER_OFFSET = 29
const OPT1_OFFSET = 34
const OPT1_TURBO_WASH = 0x20
const OPT1_PRE_WASH = 0x40 // set at start, cleared when the pre-wash phase finished
const OPT3_OFFSET = 37
const OPT3_REMOTE_START = 0x10 // set for the whole of a live cycle, as on FAFXU25006
const OPT3_CHILD_LOCK = 0x20
const OPT3_DRUM_LIGHT = 0x40
const OPT4_OFFSET = 39
const OPT4_EXTRA_RINSE = 0x40 // set at start, cleared after the first rinse

const STATE_POWEROFF = 0
const LOAD_LEVEL_UNSET = 100

// LG's washer state indices, identical in FAFXU25006 and PR #117. Seen here: Off, Initial,
// Detecting, Running, Rinsing, Spinning, End, and 36 as the previous state at every start.
const STATE = Enum.of({
    Off: 0,
    Initial: 1,
    Pause: 2,
    Detecting: 3,
    'Add drain': 5,
    'Detergent amount': 6,
    Reserved: 7,
    Soak: 8,
    'Pre-wash': 9,
    Running: 11,
    Rinsing: 12,
    'Rinse hold': 13,
    Spinning: 14,
    Drying: 15,
    End: 16,
    Refreshing: 21,
    'Error auto off': 23,
    'Audible diagnosis': 34,
    'Confirm start for control': 36,
    'Tub cleaning': 41,
    'End remote maintain on': 42,
    Steam: 43,
    'Laundry care': 47,
    'EZDispense cleaning': 48,
})

// Course codes from FAFXU25006 (WM5800HVA). Normal (46) and Delicates (22) are confirmed on this
// model; the rest are assumed to carry over. Codes outside the table publish as "code N".
const COURSE = Enum.of({
    Allergiene: 5,
    ColdWash: 6,
    'Color Care': 18,
    Delicates: 22,
    Bedding: 27,
    'Heavy Duty': 35,
    Jeans: 38,
    Normal: 46,
    'Perm. Press': 48,
    'Rinse & Spin': 55,
    Sanitary: 60,
    'Small Load': 68,
    'Quick Wash': 74,
    'Spin Only': 78,
    Towels: 84,
    'Tub Clean': 85,
    BrightWhites: 90,
    'Hand/Wool': 94,
    Activewear: 99,
    'AI Wash': 114,
    'Large Load': 132,
})

// From FAFXU25006, where each was stepped against the cloud. Here rinse 14/15 and spin 14/15 and
// soil 3 match what was selected; the rest is unconfirmed.
const SOIL = Enum.of({ Light: 1, 'Light/Normal': 2, Normal: 3, 'Normal/Heavy': 4, Heavy: 5 })
const SPIN = Enum.of({ 'Drain only': 12, Low: 13, Medium: 14, High: 15, 'Extra High': 16 })
const RINSE = Enum.of({ Normal: 14, Plus: 15, 'Plus 2': 16, 'Plus 3': 17 })

// Temperature codes do NOT follow FAFXU25006 (7-11) on this model. Seen: 19 with the hottest
// setting on Normal, 16 as Normal's power-on default, 14 as Delicates' default. Until each setting is
// stepped, publish the raw code rather than a guessed label.
const TEMP = Enum.of({} as Record<string, number>)

const BUZZER = Enum.of({ Off: 0, '1': 1, '2': 2, '3': 3, '4': 4 })

// Map a code through a table that may be incomplete: unknown codes publish as "code N" so they stay
// visible (and these sensors are plain text, not enums, so HA accepts them).
function label(table: Enum<string>, code: number) {
    return table.map(code) ?? `code ${code}`
}

function textSensor(key: string, name: string, icon: string, extra: Record<string, unknown> = {}) {
    return {
        platform: 'sensor',
        unique_id: '$deviceid-' + key,
        state_topic: '$this/' + key,
        name,
        icon,
        ...extra,
    }
}

function flag(key: string, name: string, icon: string, extra: Record<string, unknown> = {}) {
    return {
        platform: 'binary_sensor',
        unique_id: '$deviceid-' + key,
        state_topic: '$this/' + key,
        name,
        icon,
        ...extra,
    }
}

function minutes(key: string, name: string, icon: string, extra: Record<string, unknown> = {}) {
    return textSensor(key, name, icon, { device_class: 'duration', unit_of_measurement: 'min', ...extra })
}

export default class Device extends AABBDevice {
    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        // Acked like the cloud would: unacked, this module repeats each status frame up to ten times.
        super(HA, thinq, true)
        this.setConfig(
            allowExtendedType({
                ...HADevice.config(meta, { name: 'LG WashTower Washer' }),
                components: {
                    power: flag('power', 'Power', 'mdi:washing-machine', { device_class: 'running' }),
                    status: textSensor('status', 'Status', 'mdi:state-machine'),
                    previous_status: textSensor('previous_status', 'Previous status', 'mdi:history', {
                        entity_category: 'diagnostic',
                    }),
                    course: textSensor('course', 'Course', 'mdi:pin-outline'),
                    soil: textSensor('soil', 'Soil level', 'mdi:liquid-spot'),
                    temp: textSensor('temp', 'Temperature', 'mdi:thermometer-water'),
                    spin: textSensor('spin', 'Spin', 'mdi:rotate-right'),
                    rinse: textSensor('rinse', 'Rinse', 'mdi:water-sync'),
                    remaining_time: minutes('remaining_time', 'Remaining time', 'mdi:timer-outline'),
                    initial_time: minutes('initial_time', 'Initial time', 'mdi:timer-sand', {
                        entity_category: 'diagnostic',
                    }),
                    reserve_time: minutes('reserve_time', 'Delay Wash time remaining', 'mdi:clock-outline'),
                    energy: textSensor('energy', 'Energy', 'mdi:lightning-bolt', {
                        device_class: 'energy',
                        unit_of_measurement: 'Wh',
                        state_class: 'total_increasing',
                    }),
                    error: textSensor('error', 'Error code', 'mdi:alert-circle-outline', {
                        entity_category: 'diagnostic',
                    }),
                    load_level: textSensor('load_level', 'Load level', 'mdi:weight', {
                        entity_category: 'diagnostic',
                    }),
                    rinses_left: textSensor('rinses_left', 'Rinses left', 'mdi:water-sync', {
                        entity_category: 'diagnostic',
                    }),
                    tub_clean_count: textSensor('tub_clean_count', 'Washes since Tub Clean', 'mdi:counter', {
                        state_class: 'measurement',
                    }),
                    buzzer: textSensor('buzzer', 'Buzzer', 'mdi:volume-high', { entity_category: 'diagnostic' }),
                    turbo_wash: flag('turbo_wash', 'TurboWash', 'mdi:fast-forward'),
                    pre_wash: flag('pre_wash', 'Pre-Wash', 'mdi:numeric-1-circle-outline'),
                    extra_rinse: flag('extra_rinse', 'Extra Rinse', 'mdi:water-plus'),
                    remote_start: flag('remote_start', 'Remote start', 'mdi:cellphone-wireless', {
                        entity_category: 'diagnostic',
                    }),
                    child_lock: flag('child_lock', 'Child lock', 'mdi:lock-outline', {
                        entity_category: 'diagnostic',
                    }),
                    drum_light: flag('drum_light', 'Drum light', 'mdi:lightbulb', {
                        entity_category: 'diagnostic',
                    }),
                },
            }),
        )
    }

    start() {
        this.send(Buffer.from(STATUS_REQUEST, 'hex'))
    }

    processAABB(buf: Buffer) {
        this.processEnvelopedStatus(buf, CLASS_BYTE, RECORD_LEN, this.processStatus)
    }

    private processStatus(rec: Buffer) {
        const state = rec[STATE_OFFSET]
        const isOff = state === STATE_POWEROFF
        const onOff = (byte: number, bit: number) => ((rec[byte] & bit) !== 0 ? 'ON' : 'OFF')

        this.publishProperty('power', isOff ? 'OFF' : 'ON')
        this.publishProperty('status', label(STATE, state))
        this.publishProperty('previous_status', label(STATE, rec[STATE_OFFSET + 1]))
        this.publishProperty('course', isOff ? undefined : label(COURSE, rec[COURSE_OFFSET]))
        this.publishProperty('soil', isOff ? undefined : label(SOIL, rec[SOIL_OFFSET]))
        this.publishProperty('temp', isOff ? undefined : label(TEMP, rec[TEMP_OFFSET]))
        this.publishProperty('spin', isOff ? undefined : label(SPIN, rec[SPIN_OFFSET]))
        this.publishProperty('rinse', isOff ? undefined : label(RINSE, rec[RINSE_OFFSET]))
        this.publishProperty('remaining_time', isOff ? 0 : rec.readUInt16BE(REMAIN_TIME_OFFSET))
        this.publishProperty('initial_time', isOff ? 0 : rec.readUInt16BE(INITIAL_TIME_OFFSET))
        this.publishProperty('reserve_time', rec.readUInt16BE(RESERVE_TIME_OFFSET))
        this.publishProperty('energy', rec.readUInt16BE(SPENT_POWER_OFFSET))
        this.publishProperty('error', rec[ERROR_OFFSET] === 0 ? 'None' : `code ${rec[ERROR_OFFSET]}`)
        const load = rec[LOAD_LEVEL_OFFSET]
        this.publishProperty('load_level', load === LOAD_LEVEL_UNSET ? undefined : load)
        this.publishProperty('rinses_left', rec[RINSES_LEFT_OFFSET])
        this.publishProperty('tub_clean_count', rec[TUB_CLEAN_COUNT_OFFSET])
        this.publishProperty('buzzer', label(BUZZER, rec[BUZZER_OFFSET]))
        this.publishProperty('turbo_wash', onOff(OPT1_OFFSET, OPT1_TURBO_WASH))
        this.publishProperty('pre_wash', onOff(OPT1_OFFSET, OPT1_PRE_WASH))
        this.publishProperty('extra_rinse', onOff(OPT4_OFFSET, OPT4_EXTRA_RINSE))
        this.publishProperty('remote_start', onOff(OPT3_OFFSET, OPT3_REMOTE_START))
        this.publishProperty('child_lock', onOff(OPT3_OFFSET, OPT3_CHILD_LOCK))
        this.publishProperty('drum_light', onOff(OPT3_OFFSET, OPT3_DRUM_LIGHT))
    }
}
