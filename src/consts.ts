
/**
 * WIDE IDS — WHY A LOG ENTRY IS TWO WORDS AND NOT ONE.
 *
 * Upstream packs (entityId, componentTypeId, runHeaderFlag) into ONE 32-bit word: 22 bits of
 * entity, 9 bits of type, 1 flag. That caps a world at 512 component classes and at 4.19M
 * entities, and neither cap is a property of an ECS — both are the width of the word the pair
 * happens to travel in.
 *
 * REDISTRIBUTING THOSE BITS IS NOT A FIX. Every bit handed to the type axis is taken from the
 * entity axis; the sum stays 32. A model that grows on both axes cannot be served by any split.
 *
 * NEITHER IS ARITHMETIC PACKING INTO A DOUBLE. A JS number holds integers exactly only to 2^53,
 * so entity + type + flag would have to fit in 53 bits — a smaller ceiling, chosen for
 * convenience, that would be hit again later. Ceilings that are not needed are not introduced.
 *
 * SO THE PAIR TRAVELS AS TWO WORDS: one for the entity, one for the type plus its marker. Both
 * axes reach 2^31 without sharing a budget, and no arithmetic loses precision. The log stores two
 * slots per entry; that log is the record of what changed in a frame, never the component data.
 *
 * JS BIT OPERATORS ARE WHY THIS CANNOT BE DONE WITH CONSTANTS ALONE: `<<`, `>>>`, `|` and `&`
 * coerce to signed 32-bit integers and shift MODULO 32, so `x << 32` silently means `x << 0`.
 * A field wider than the word cannot be reached by changing a number; the packing itself has to
 * change shape.
 */

/**
 * Entity ids use 31 bits, and the reason is not the log — it is the REFERENCE FIELDS.
 *
 * An entity reference stored in a component field (`type.ts`) is a uint32 whose top bit marks the
 * reference as stale. Taking that bit for the id would widen every stored reference in the data
 * model, for an axis already counted in billions: 2^31 is 2.147 billion entities per world, and
 * worlds are multiplied by the compute fleet. The bit stays where it belongs.
 */
export const ENTITY_ID_BITS = 31;
/** Component type ids use 31 bits; the top bit of their word carries the run header marker. */
export const COMPONENT_ID_BITS = 31;
export const FIELD_SEQ_BITS = 7;

export const MAX_NUM_ENTITIES = 2 ** ENTITY_ID_BITS;
/** Kept for reference fields, which pack an id and a stale marker into one word. */
export const ENTITY_ID_MASK = MAX_NUM_ENTITIES - 1;
export const MAX_NUM_COMPONENTS = 2 ** COMPONENT_ID_BITS;
export const COMPONENT_ID_MASK = MAX_NUM_COMPONENTS - 1;
export const MAX_NUM_FIELDS = 2 ** FIELD_SEQ_BITS;
export const FIELD_SEQ_MASK = MAX_NUM_FIELDS - 1;

// TODO: enforce max length of ref structs/arrays

/**
 * The run header marker, carried in the top bit of the TYPE word.
 *
 * It marks a synthetic entry announcing "the next N entries share this type", used when the log is
 * sorted by component type. It lives in the type word because that word is the one this fork
 * widened; the entity word carries an id that reference fields also have to hold.
 */
export const RUN_HEADER_FLAG = 2 ** 31;

/** Slots occupied by one log entry: the entity word, then the type word. */
export const LOG_ENTRY_WORDS = 2;
