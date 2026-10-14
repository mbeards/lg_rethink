import { Device as Thinq2Device } from '../thinq2/device'
import { type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import BDH_D30007_US from './BDH_D30007_US'

// LG WashTower WKHC252HWA, dryer half: modelId "BDH_D39304_US" (thinq2 deviceType 222), a heat-pump
// dryer sharing one Wi-Fi module with the washer half (FAKPU23016).
//
// Its 0xEB status record is the same 42-byte layout as the standalone BDH_D30007_US, only under class
// byte 0x34 instead of 0x30. Checked against a captured Normal cycle: course 7 (Normal), dry level 3,
// Eco Hybrid 2, remaining/initial time 65 min big-endian at rec[9]/rec[11], state 7 (Drying), and
// energy ticking at rec[17:19]. Not cross-checked against LG's cloud.
const CLASS_BYTE = 0x34

export default class Device extends BDH_D30007_US {
    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq, meta, CLASS_BYTE)
    }
}
