import type { RobotVehicle } from './prefetch-robots';

export type RobotSupportRole = 'carry' | 'lift' | 'tow';
export type RobotAttachment = 'deck' | 'sling' | 'fork' | 'towline';
export const ROBOT_ENERGY_PROFILES = Object.freeze({
    battery: Object.freeze({ source: 'battery', service: 'charge', serviceLabel: 'Charging' } as const),
    petrol: Object.freeze({ source: 'petrol', service: 'refuel', serviceLabel: 'Refuelling' } as const),
});
export type RobotEnergyProfile = typeof ROBOT_ENERGY_PROFILES[keyof typeof ROBOT_ENERGY_PROFILES];
export type RobotEnergyService = RobotEnergyProfile['service'];
export interface RobotPersonality {
    teamPreference: number;
    independence: number;
    emergencyBoldness: number;
    reverseAversion: number;
    carrierAffinity: number;
}
export interface RobotStructure {
    mobility: 'air' | 'ground';
    /** Relative scene mass. The same mass enters bearing, traction and carried-body loads. */
    mass: number;
    chassis: 'airframe' | 'loadBearing';
    traction: 'none' | 'wheels' | 'utilityWheels' | 'counterweightedWheels' | 'omni' | 'legs' | 'biped';
    liftMechanism: 'none' | 'rotor' | 'tiltRotor' | 'forks';
    attachments: readonly RobotAttachment[];
    energy: RobotEnergyProfile;
    /** Relative visual presence; mechanical capability and backing density are independent. */
    presentationScale: number;
    interactionCue?: string;
    personality: Readonly<RobotPersonality>;
}
export interface RobotCapabilities {
    mobility: RobotStructure['mobility'];
    mass: number;
    carry: number;
    lift: number;
    tow: number;
}

/** Artistic scene coefficients, shared by document work, body transport and rescue. */
export const ROBOT_STRUCTURE_POLICY = Object.freeze({
    bearing: Object.freeze({ airframe: 0, loadBearing: 1 }),
    traction: Object.freeze({ none: 0, wheels: 1, utilityWheels: 10 / 9,
        counterweightedWheels: 1.6, omni: 1, legs: 1, biped: 0.5 }),
    lifting: Object.freeze({ none: 0, rotor: 1, tiltRotor: 0.5, forks: 0.6 }),
    /** Concurrent roles share effort. Their own mechanism is fully charged; cross-mechanism work also consumes reserve. */
    crossMechanismEffort: 0.25,
});

const personality = Object.freeze({ teamPreference: 1, independence: 1, emergencyBoldness: 1,
    reverseAversion: 0, carrierAffinity: 0 });
function describe(mass: number, mobility: RobotStructure['mobility'], traction: RobotStructure['traction'],
    liftMechanism: RobotStructure['liftMechanism'], attachments: readonly RobotAttachment[],
    options: { personality?: Partial<RobotPersonality>; energy?: keyof typeof ROBOT_ENERGY_PROFILES;
        presentationScale?: number; interactionCue?: string } = {}): Readonly<RobotStructure> {
    return Object.freeze({ mass, mobility, chassis: mobility === 'air' ? 'airframe' : 'loadBearing', traction, liftMechanism,
        attachments: Object.freeze([...attachments]), energy: ROBOT_ENERGY_PROFILES[options.energy ?? 'battery'],
        presentationScale: options.presentationScale ?? 1, interactionCue: options.interactionCue,
        personality: Object.freeze({ ...personality, ...options.personality }) });
}

/** Structural and personality descriptions are authored here; operation planners consume derived affordances. */
export const ROBOT_STRUCTURES: Readonly<Record<RobotVehicle, Readonly<RobotStructure>>> = Object.freeze({
    quad: describe(1, 'air', 'none', 'rotor', ['sling']),
    heavyquad: describe(3, 'air', 'none', 'rotor', ['sling'], { energy: 'petrol', presentationScale: 2.5,
        interactionCue: 'Četiri benzinska motora. Jedna sličica.' }),
    tiltwing: describe(2, 'air', 'none', 'tiltRotor', ['sling']),
    rover: describe(9, 'ground', 'utilityWheels', 'none', ['deck', 'towline', 'sling']),
    mecanum: describe(3, 'ground', 'omni', 'none', ['deck', 'towline', 'sling']),
    forklift: describe(5, 'ground', 'counterweightedWheels', 'forks', ['deck', 'fork', 'towline', 'sling']),
    hexapod: describe(2, 'ground', 'legs', 'none', ['deck', 'towline', 'sling']),
    walker: describe(2, 'ground', 'biped', 'none', ['deck', 'towline', 'sling']),
    lugv: describe(1, 'ground', 'wheels', 'none', ['deck', 'towline', 'sling'], { personality: { reverseAversion: 1, carrierAffinity: 1 } }),
    ekokomvoz: describe(10, 'ground', 'wheels', 'none', ['deck', 'towline', 'sling']),
});

export function robotStructure(vehicle: string): Readonly<RobotStructure> | undefined {
    return Object.prototype.hasOwnProperty.call(ROBOT_STRUCTURES, vehicle) ? ROBOT_STRUCTURES[vehicle as RobotVehicle] : undefined;
}

export function robotPresentationScale(vehicle: string): number {
    return robotStructure(vehicle)?.presentationScale ?? 1;
}

function capabilities(structure: Readonly<RobotStructure>): Readonly<RobotCapabilities> {
    const lift = structure.mass * ROBOT_STRUCTURE_POLICY.lifting[structure.liftMechanism];
    return Object.freeze({ mobility: structure.mobility, mass: structure.mass, lift,
        carry: structure.mobility === 'air' ? lift : structure.mass * ROBOT_STRUCTURE_POLICY.bearing[structure.chassis],
        tow: structure.mass * ROBOT_STRUCTURE_POLICY.traction[structure.traction] });
}

export const ROBOT_CAPABILITIES: Readonly<Record<RobotVehicle, Readonly<RobotCapabilities>>> = Object.freeze(
    Object.fromEntries(Object.entries(ROBOT_STRUCTURES).map(([vehicle, structure]) => [vehicle, capabilities(structure)])) as
        Record<RobotVehicle, Readonly<RobotCapabilities>>);

export function robotCapabilities(vehicle: string): Readonly<RobotCapabilities> | undefined {
    return robotStructure(vehicle) ? ROBOT_CAPABILITIES[vehicle as RobotVehicle] : undefined;
}

export function robotSupport(vehicle: string, role: RobotSupportRole, attachment?: RobotAttachment): number {
    const structure = robotStructure(vehicle), capability = robotCapabilities(vehicle);
    if (!structure || !capability || attachment && !structure.attachments.includes(attachment)) { return 0; }
    return capability[role];
}

export function robotSupportMechanism(vehicle: string, role: RobotSupportRole): 'bearing' | 'lifting' | 'traction' {
    return role === 'tow' ? 'traction' : role === 'lift' || robotStructure(vehicle)?.mobility === 'air' ? 'lifting' : 'bearing';
}
