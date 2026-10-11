import { describe, it, expect } from 'vitest';
import {
  createJourneyMask,
  isSeatAvailable,
  occupySeat,
  releaseSeat,
  countAvailableSeats,
  resolveStationIndices,
} from '../src/bitmask';

describe('Bitmask Logic', () => {
  describe('createJourneyMask', () => {
    it('should create mask for single segment (adjacent stations)', () => {
      // A(0) -> B(1): segment 0 only
      const mask = createJourneyMask(0, 1);
      expect(mask).toBe(0b1); // 1
    });

    it('should create mask for two segments', () => {
      // A(0) -> C(2): segments 0,1
      const mask = createJourneyMask(0, 2);
      expect(mask).toBe(0b11); // 3
    });

    it('should create mask for middle segments', () => {
      // C(2) -> E(4): segments 2,3
      const mask = createJourneyMask(2, 4);
      expect(mask).toBe(0b1100); // 12
    });

    it('should create mask for full route (5 segments)', () => {
      // A(0) -> F(5): segments 0,1,2,3,4
      const mask = createJourneyMask(0, 5);
      expect(mask).toBe(0b11111); // 31
    });

    it('should throw for invalid indices (from >= to)', () => {
      expect(() => createJourneyMask(3, 2)).toThrow();
      expect(() => createJourneyMask(3, 3)).toThrow();
    });

    it('should throw for negative indices', () => {
      expect(() => createJourneyMask(-1, 2)).toThrow();
    });
  });

  describe('isSeatAvailable', () => {
    it('should return true for empty seat', () => {
      const occupied = 0;
      const journey = createJourneyMask(0, 3);
      expect(isSeatAvailable(occupied, journey)).toBe(true);
    });

    it('should return true for non-overlapping segments', () => {
      // Seat booked A->C (segments 0,1), checking C->E (segments 2,3)
      const occupied = createJourneyMask(0, 2); // 0b0011
      const journey = createJourneyMask(2, 4);   // 0b1100
      expect(isSeatAvailable(occupied, journey)).toBe(true);
    });

    it('should return false for overlapping segments', () => {
      // Seat booked A->C (segments 0,1), checking B->D (segments 1,2)
      const occupied = createJourneyMask(0, 2); // 0b0011
      const journey = createJourneyMask(1, 3);   // 0b0110
      expect(isSeatAvailable(occupied, journey)).toBe(false);
    });

    it('should return false for fully overlapping journey', () => {
      // Seat booked A->E, checking B->D
      const occupied = createJourneyMask(0, 4);
      const journey = createJourneyMask(1, 3);
      expect(isSeatAvailable(occupied, journey)).toBe(false);
    });

    it('should handle the classic IRCTC example: A->C + C->E', () => {
      // First booking: A(0) -> C(2) = segments 0,1
      let occupied = createJourneyMask(0, 2); // 3
      
      // Second booking: C(2) -> E(4) = segments 2,3
      const secondJourney = createJourneyMask(2, 4); // 12
      
      // These should NOT overlap
      expect(isSeatAvailable(occupied, secondJourney)).toBe(true);
      
      // But B(1) -> D(3) = segments 1,2 SHOULD overlap with first booking
      const conflicting = createJourneyMask(1, 3); // 6
      expect(isSeatAvailable(occupied, conflicting)).toBe(false);
    });
  });

  describe('occupySeat / releaseSeat', () => {
    it('should correctly occupy and release segments', () => {
      let mask = 0;

      // Book A->C
      const ac = createJourneyMask(0, 2);
      mask = occupySeat(mask, ac);
      expect(mask).toBe(0b11);

      // Book C->E
      const ce = createJourneyMask(2, 4);
      mask = occupySeat(mask, ce);
      expect(mask).toBe(0b1111);

      // Cancel A->C
      mask = releaseSeat(mask, ac);
      expect(mask).toBe(0b1100);

      // Now A->C should be available again
      expect(isSeatAvailable(mask, ac)).toBe(true);

      // But B->D still blocked by C->E
      const bd = createJourneyMask(1, 3);
      expect(isSeatAvailable(mask, bd)).toBe(false);
    });
  });

  describe('countAvailableSeats', () => {
    it('should count all available seats', () => {
      const seatMasks = [0, 0, 0b11, 0b1100, 0b1111];
      const journey = createJourneyMask(2, 4); // segments 2,3 = 0b1100

      // Seat 0: 0 & 12 = 0 → available
      // Seat 1: 0 & 12 = 0 → available
      // Seat 2: 3 & 12 = 0 → available (A->C doesn't conflict with C->E)
      // Seat 3: 12 & 12 = 12 → NOT available
      // Seat 4: 15 & 12 = 12 → NOT available
      expect(countAvailableSeats(seatMasks, journey)).toBe(3);
    });
  });

  describe('resolveStationIndices', () => {
    const route = ['New Delhi', 'Kanpur', 'Allahabad', 'Mughal Sarai', 'Patna', 'Kolkata'];

    it('should resolve valid station names', () => {
      const { fromIndex, toIndex } = resolveStationIndices(route, 'New Delhi', 'Kolkata');
      expect(fromIndex).toBe(0);
      expect(toIndex).toBe(5);
    });

    it('should resolve middle stations', () => {
      const { fromIndex, toIndex } = resolveStationIndices(route, 'Kanpur', 'Patna');
      expect(fromIndex).toBe(1);
      expect(toIndex).toBe(4);
    });

    it('should throw for invalid station name', () => {
      expect(() => resolveStationIndices(route, 'NonExistent', 'Kolkata')).toThrow();
    });

    it('should throw for reversed direction', () => {
      expect(() => resolveStationIndices(route, 'Kolkata', 'New Delhi')).toThrow();
    });
  });

  describe('Multiple bookings on same seat', () => {
    it('should allow three non-overlapping bookings on same seat', () => {
      // 6-station route: segments 0,1,2,3,4
      let mask = 0;

      // Book A->B (segment 0)
      const ab = createJourneyMask(0, 1);
      expect(isSeatAvailable(mask, ab)).toBe(true);
      mask = occupySeat(mask, ab);

      // Book B->D (segments 1,2)
      const bd = createJourneyMask(1, 3);
      expect(isSeatAvailable(mask, bd)).toBe(true);
      mask = occupySeat(mask, bd);

      // Book D->F (segments 3,4)
      const df = createJourneyMask(3, 5);
      expect(isSeatAvailable(mask, df)).toBe(true);
      mask = occupySeat(mask, df);

      // Now seat is fully booked
      expect(mask).toBe(0b11111);

      // No more journeys should be available
      for (let i = 0; i < 5; i++) {
        for (let j = i + 1; j <= 5; j++) {
          expect(isSeatAvailable(mask, createJourneyMask(i, j))).toBe(false);
        }
      }
    });
  });
});
