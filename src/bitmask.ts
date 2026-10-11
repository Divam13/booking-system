/**
 * Segment-based seat booking using bitmasks.
 *
 * A train with N ordered stations has N-1 segments.
 * Station indices: 0, 1, 2, ..., N-1
 * Segment i covers the gap between station i and station i+1.
 *
 * A journey from station `from` to station `to` occupies segments [from, to-1].
 * The bitmask for this journey has bits `from` through `to-1` set.
 *
 * A seat is available for a journey if:
 *   (occupiedMask & journeyMask) === 0
 *
 * Example with 5 stations (A=0, B=1, C=2, D=3, E=4):
 *   Journey A->C occupies segments 0,1 => mask = 0b00011 = 3
 *   Journey C->E occupies segments 2,3 => mask = 0b01100 = 12
 *   These don't overlap, so the seat can accommodate both.
 *   Journey B->D occupies segments 1,2 => mask = 0b00110 = 6
 *   This overlaps with A->C (both use segment 1), so it's blocked.
 */

/**
 * Creates a bitmask for a journey between two station indices.
 * @param fromIndex - Starting station index (0-based)
 * @param toIndex - Ending station index (0-based, must be > fromIndex)
 * @returns The bitmask representing the occupied segments
 */
export function createJourneyMask(fromIndex: number, toIndex: number): number {
  if (fromIndex < 0 || toIndex <= fromIndex) {
    throw new Error(
      `Invalid station indices: from=${fromIndex}, to=${toIndex}. ` +
      `'to' must be greater than 'from' and both must be non-negative.`
    );
  }
  if (toIndex > 31) {
    throw new Error(
      `Station index ${toIndex} exceeds maximum of 31 for 32-bit bitmask operations.`
    );
  }

  // Set bits from fromIndex to toIndex-1
  // Formula: ((1 << (to - from)) - 1) << from
  const numSegments = toIndex - fromIndex;
  const mask = ((1 << numSegments) - 1) << fromIndex;
  return mask;
}

/**
 * Checks if a seat is available for a given journey.
 * @param occupiedMask - Current bitmask of occupied segments for the seat
 * @param journeyMask - Bitmask of segments needed for the new journey
 * @returns true if the seat is free for this journey
 */
export function isSeatAvailable(occupiedMask: number, journeyMask: number): boolean {
  return (occupiedMask & journeyMask) === 0;
}

/**
 * Adds a journey to the seat's occupied segments.
 * @param occupiedMask - Current bitmask of occupied segments
 * @param journeyMask - Bitmask of segments to occupy
 * @returns Updated occupied mask
 */
export function occupySeat(occupiedMask: number, journeyMask: number): number {
  return occupiedMask | journeyMask;
}

/**
 * Releases a journey from the seat's occupied segments.
 * @param occupiedMask - Current bitmask of occupied segments
 * @param journeyMask - Bitmask of segments to release
 * @returns Updated occupied mask with the journey segments cleared
 */
export function releaseSeat(occupiedMask: number, journeyMask: number): number {
  return occupiedMask & ~journeyMask;
}

/**
 * Counts the number of available seats for a journey from a list of seat masks.
 * @param seatMasks - Array of occupied bitmasks, one per seat
 * @param journeyMask - Bitmask of the desired journey
 * @returns Number of seats available for this journey
 */
export function countAvailableSeats(seatMasks: number[], journeyMask: number): number {
  return seatMasks.filter((mask) => isSeatAvailable(mask, journeyMask)).length;
}

/**
 * Converts station indices to a human-readable segment string.
 * @param fromIndex - Starting station index
 * @param toIndex - Ending station index
 * @returns String showing which segments are occupied
 */
export function describeSegments(fromIndex: number, toIndex: number): string {
  const segments: string[] = [];
  for (let i = fromIndex; i < toIndex; i++) {
    segments.push(`seg${i}`);
  }
  return segments.join(', ');
}

/**
 * Given station names and a route, resolves from/to names into indices.
 */
export function resolveStationIndices(
  route: string[],
  fromStation: string,
  toStation: string
): { fromIndex: number; toIndex: number } {
  const fromIndex = route.indexOf(fromStation);
  const toIndex = route.indexOf(toStation);

  if (fromIndex === -1) {
    throw new Error(`Station '${fromStation}' not found on this route.`);
  }
  if (toIndex === -1) {
    throw new Error(`Station '${toStation}' not found on this route.`);
  }
  if (fromIndex >= toIndex) {
    throw new Error(
      `Invalid direction: '${fromStation}' (index ${fromIndex}) must come before '${toStation}' (index ${toIndex}).`
    );
  }

  return { fromIndex, toIndex };
}
