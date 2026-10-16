import type { SkillSource } from "../../core/skills/schemas.js";
import { generic } from "./generic.js";
import { iotBleFeature } from "./iot-ble-feature.js";

export const packagedSkills: readonly SkillSource[] = [generic, iotBleFeature];
