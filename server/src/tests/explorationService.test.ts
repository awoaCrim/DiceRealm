import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  skillCheck,
  stealthCheck,
  perceptionCheck,
  investigationCheck,
  lockpick,
  disarmTrap,
  trackTarget,
  solvePuzzle
} from '../services/explorationService.js';

describe('explorationService', () => {
  describe('skillCheck', () => {
    it('succeeds when total >= dc', () => {
      vi.spyOn(Math, 'random').mockReturnValue(0.5); // roll=11
      // mod = floor((14-10)/2)=2, total = 11+2+0 = 13 >= 12
      const result = skillCheck(14, 12, 0);
      expect(result.success).toBe(true);
      expect(result.criticalSuccess).toBe(false);
      expect(result.criticalFail).toBe(false);
      expect(result.roll).toBe(11);
      expect(result.total).toBe(13);
      expect(result.dc).toBe(12);
      vi.restoreAllMocks();
    });

    it('fails when total < dc', () => {
      vi.spyOn(Math, 'random').mockReturnValue(0); // roll=1
      // mod = floor((8-10)/2)=-1, total = 1+(-1)+0 = 0 < 15
      const result = skillCheck(8, 15, 0);
      expect(result.success).toBe(false);
      expect(result.total).toBe(0);
      vi.restoreAllMocks();
    });

    it('natural20 is criticalSuccess regardless of DC', () => {
      vi.spyOn(Math, 'random').mockReturnValue(19 / 20); // roll=20
      const result = skillCheck(10, 99, 0);
      expect(result.success).toBe(true);
      expect(result.criticalSuccess).toBe(true);
      expect(result.criticalFail).toBe(false);
      expect(result.description).toContain('大成功');
      vi.restoreAllMocks();
    });

    it('natural1 is criticalFail regardless of modifiers', () => {
      vi.spyOn(Math, 'random').mockReturnValue(0); // roll=1
      const result = skillCheck(30, 1, 10);
      expect(result.success).toBe(false);
      expect(result.criticalSuccess).toBe(false);
      expect(result.criticalFail).toBe(true);
      expect(result.description).toContain('大失败');
      vi.restoreAllMocks();
    });

    it('applies proficiency bonus to total', () => {
      vi.spyOn(Math, 'random').mockReturnValue(0.5); // roll=11
      // mod=2, prof=3, total = 11+2+3 = 16
      const result = skillCheck(14, 15, 3);
      expect(result.total).toBe(16);
      expect(result.success).toBe(true); // 16 >= 15
      vi.restoreAllMocks();
    });

    it('supports advantage option', () => {
      vi.spyOn(Math, 'random')
        .mockReturnValueOnce(0.1)  // roll=3
        .mockReturnValueOnce(0.9); // roll=19, advantage takes max=19
      // mod=2, prof=2, total = 19+2+2 = 23
      const result = skillCheck(14, 20, 2, 'advantage');
      expect(result.total).toBe(23);
      expect(result.success).toBe(true);
      vi.restoreAllMocks();
    });

    it('supports disadvantage option', () => {
      vi.spyOn(Math, 'random')
        .mockReturnValueOnce(0.2)  // roll=5
        .mockReturnValueOnce(0.8); // roll=17, disadvantage takes min=5
      // mod=2, prof=2, total = 5+2+2 = 9
      const result = skillCheck(14, 10, 2, 'disadvantage');
      expect(result.total).toBe(9);
      expect(result.success).toBe(false); // 9 < 10
      vi.restoreAllMocks();
    });

    it('includes correct description on failure', () => {
      vi.spyOn(Math, 'random').mockReturnValue(0.2); // roll=5, not natural1
      // mod=0, total=5 < 15
      const result = skillCheck(10, 15, 0);
      expect(result.description).toContain('检定失败（DC 15）');
      vi.restoreAllMocks();
    });
  });

  describe('stealthCheck', () => {
    it('defaults to DC 12', () => {
      vi.spyOn(Math, 'random').mockReturnValue(0.5); // roll=11
      // dex 14 = mod 2, total = 11+2+0 = 13 >= 12
      const result = stealthCheck(14);
      expect(result.dc).toBe(12);
      expect(result.success).toBe(true);
      vi.restoreAllMocks();
    });

    it('applies proficiency', () => {
      vi.spyOn(Math, 'random').mockReturnValue(0); // roll=1
      // wis 10 = mod 0, prof=5, total = 1+0+5 = 6 < 12
      const result = stealthCheck(10, 5);
      expect(result.total).toBe(6);
      expect(result.success).toBe(false);
      vi.restoreAllMocks();
    });
  });

  describe('perceptionCheck', () => {
    it('defaults to DC 12', () => {
      vi.spyOn(Math, 'random').mockReturnValue(0.5); // roll=11
      // wis 14 = mod 2, total = 11+2 = 13 >= 12
      const result = perceptionCheck(14);
      expect(result.dc).toBe(12);
      expect(result.success).toBe(true);
      vi.restoreAllMocks();
    });

    it('uses wisdom modifier', () => {
      vi.spyOn(Math, 'random').mockReturnValue(0.5); // roll=11
      // wis 8 = mod -1, total = 11+(-1) = 10 < 12
      const result = perceptionCheck(8);
      expect(result.total).toBe(10);
      expect(result.success).toBe(false);
      vi.restoreAllMocks();
    });
  });

  describe('investigationCheck', () => {
    it('defaults to DC 13', () => {
      vi.spyOn(Math, 'random').mockReturnValue(0.5); // roll=11
      // int 16 = mod 3, total = 11+3 = 14 >= 13
      const result = investigationCheck(16);
      expect(result.dc).toBe(13);
      expect(result.success).toBe(true);
      vi.restoreAllMocks();
    });

    it('accepts custom DC', () => {
      vi.spyOn(Math, 'random').mockReturnValue(0.5); // roll=11
      // int 16 = mod 3, total = 14 < 18
      const result = investigationCheck(16, 0, 18);
      expect(result.dc).toBe(18);
      expect(result.success).toBe(false);
      vi.restoreAllMocks();
    });
  });

  describe('lockpick', () => {
    it('defaults to DC 15', () => {
      vi.spyOn(Math, 'random').mockReturnValue(0.5); // roll=11
      // dex 18 = mod 4, prof=2, total = 11+4+2 = 17 >= 15
      const result = lockpick(18, 2);
      expect(result.dc).toBe(15);
      expect(result.success).toBe(true);
      vi.restoreAllMocks();
    });

    it('fails with low dexterity', () => {
      vi.spyOn(Math, 'random').mockReturnValue(0); // roll=1
      const result = lockpick(8, 0);
      expect(result.success).toBe(false);
      vi.restoreAllMocks();
    });
  });

  describe('disarmTrap', () => {
    it('defaults to DC 15', () => {
      vi.spyOn(Math, 'random').mockReturnValue(0.5); // roll=11
      // dex 16 = mod 3, prof=2, total = 11+3+2 = 16 >= 15
      const result = disarmTrap(16, 2);
      expect(result.dc).toBe(15);
      expect(result.success).toBe(true);
      vi.restoreAllMocks();
    });
  });

  describe('trackTarget', () => {
    it('defaults to DC 13', () => {
      vi.spyOn(Math, 'random').mockReturnValue(0.5); // roll=11
      // wis 16 = mod 3, total = 11+3 = 14 >= 13
      const result = trackTarget(16);
      expect(result.dc).toBe(13);
      expect(result.success).toBe(true);
      vi.restoreAllMocks();
    });

    it('benefits from survival proficiency', () => {
      vi.spyOn(Math, 'random').mockReturnValue(0); // roll=1
      // wis 10 = mod 0, prof=4, total = 1+0+4 = 5 < 13
      const result = trackTarget(10, 4);
      expect(result.total).toBe(5);
      expect(result.success).toBe(false);
      vi.restoreAllMocks();
    });
  });

  describe('solvePuzzle', () => {
    it('defaults to DC 12 with no proficiency', () => {
      vi.spyOn(Math, 'random').mockReturnValue(0.5); // roll=11
      // int 16 = mod 3, total = 11+3 = 14 >= 12
      const result = solvePuzzle(16);
      expect(result.dc).toBe(12);
      expect(result.success).toBe(true);
      vi.restoreAllMocks();
    });
  });
});
