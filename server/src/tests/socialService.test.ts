import { describe, it, expect, vi } from 'vitest';
import {
  attitudeModifier,
  socialCheck,
  persuade,
  deceive,
  intimidate,
  haggle,
  negotiate
} from '../services/socialService.js';

describe('socialService', () => {
  describe('attitudeModifier', () => {
    it('returns 5 for hostile', () => {
      expect(attitudeModifier('hostile')).toBe(5);
    });

    it('returns 2 for unfriendly', () => {
      expect(attitudeModifier('unfriendly')).toBe(2);
    });

    it('returns 0 for neutral', () => {
      expect(attitudeModifier('neutral')).toBe(0);
    });

    it('returns -2 for friendly', () => {
      expect(attitudeModifier('friendly')).toBe(-2);
    });

    it('returns -5 for allied', () => {
      expect(attitudeModifier('allied')).toBe(-5);
    });
  });

  describe('socialCheck', () => {
    it('adjusts DC by attitude modifier', () => {
      vi.spyOn(Math, 'random').mockReturnValue(0.5); // roll=11
      // cha 14 = mod 2, neutral DC 15, adjustedDc=15+0=15
      // total = 11+2 = 13 < 15 => fail
      const result = socialCheck('persuasion', 14, 'neutral', 15, 0);
      expect(result.adjustedDc).toBe(15);
      expect(result.success).toBe(false);
      vi.restoreAllMocks();
    });

    it('friendly attitude lowers DC making success easier', () => {
      vi.spyOn(Math, 'random').mockReturnValue(0.5); // roll=11
      // cha 14 = mod 2, friendly DC 15, adjustedDc=15+(-2)=13
      // total = 11+2 = 13 >= 13 => success
      const result = socialCheck('persuasion', 14, 'friendly', 15, 0);
      expect(result.adjustedDc).toBe(13);
      expect(result.success).toBe(true);
      expect(result.resultText).toContain('对方态度友善');
      vi.restoreAllMocks();
    });

    it('hostile attitude raises DC making success harder', () => {
      vi.spyOn(Math, 'random').mockReturnValue(0.5); // roll=11
      // cha 14 = mod 2, hostile DC 10, adjustedDc=10+5=15
      // total = 11+2 = 13 < 15 => fail
      const result = socialCheck('persuasion', 14, 'hostile', 10, 0);
      expect(result.adjustedDc).toBe(15);
      expect(result.success).toBe(false);
      expect(result.resultText).toContain('对方态度不佳');
      vi.restoreAllMocks();
    });

    it('applies proficiency bonus', () => {
      vi.spyOn(Math, 'random').mockReturnValue(0.5); // roll=11
      // cha 14 = mod 2, prof=3, neutral DC 15
      // total = 11+2+3 = 16 >= 15 => success
      const result = socialCheck('deception', 14, 'neutral', 15, 3);
      expect(result.total).toBe(16);
      expect(result.success).toBe(true);
      vi.restoreAllMocks();
    });
  });

  describe('persuade', () => {
    it('uses default DC 15', () => {
      vi.spyOn(Math, 'random').mockReturnValue(0.5); // roll=11
      // cha 16 = mod 3, neutral, adjustedDc=15
      // total = 11+3 = 14 < 15 => fail
      const result = persuade(16, 'neutral');
      expect(result.adjustedDc).toBe(15);
      expect(result.success).toBe(false);
      vi.restoreAllMocks();
    });

    it('succeeds with friendly NPC', () => {
      vi.spyOn(Math, 'random').mockReturnValue(0.5); // roll=11
      // cha 16 = mod 3, friendly DC 15, adjustedDc=15-2=13
      // total = 11+3 = 14 >= 13 => success
      const result = persuade(16, 'friendly');
      expect(result.adjustedDc).toBe(13);
      expect(result.success).toBe(true);
      vi.restoreAllMocks();
    });
  });

  describe('deceive', () => {
    it('uses default DC 15', () => {
      vi.spyOn(Math, 'random').mockReturnValue(0.5); // roll=11
      // cha 12 = mod 1, neutral DC 15, total = 12 < 15 => fail
      const result = deceive(12, 'neutral');
      expect(result.adjustedDc).toBe(15);
      expect(result.success).toBe(false);
      vi.restoreAllMocks();
    });
  });

  describe('intimidate', () => {
    it('has higher DC (15+2=17 base)', () => {
      vi.spyOn(Math, 'random').mockReturnValue(0.5); // roll=11
      // cha 18 = mod 4, neutral, adjustedDc=17+0=17
      // total = 11+4 = 15 < 17 => fail (harder check)
      const result = intimidate(18, 'neutral');
      expect(result.adjustedDc).toBe(17);
      expect(result.success).toBe(false);
      vi.restoreAllMocks();
    });
  });

  describe('haggle', () => {
    it('returns discount on success', () => {
      vi.spyOn(Math, 'random').mockReturnValue(0.5); // roll=11
      // cha 20 = mod 5, allied DC 15, adjustedDc=15-5=10
      // total = 11+5 = 16 >= 10 => success, discount = floor(100*0.2)=20
      const result = haggle(20, 'allied', 100);
      expect(result.success).toBe(true);
      expect(result.basePrice).toBe(100);
      expect(result.discount).toBe(20);
      expect(result.finalPrice).toBe(80);
      vi.restoreAllMocks();
    });

    it('returns no discount on failure', () => {
      vi.spyOn(Math, 'random').mockReturnValue(0); // roll=1
      // cha 10 = mod 0, hostile DC 15, adjustedDc=15+5=20
      // total = 1+0 = 1 < 20 => fail
      const result = haggle(10, 'hostile', 200);
      expect(result.success).toBe(false);
      expect(result.discount).toBe(0);
      expect(result.finalPrice).toBe(200);
      vi.restoreAllMocks();
    });
  });

  describe('negotiate', () => {
    it('succeeds with 2 of 3 checks passed', () => {
      vi.spyOn(Math, 'random')
        .mockReturnValueOnce(0.9)  // roll=19, check1=true
        .mockReturnValueOnce(0.9)  // roll=19, check2=true
        .mockReturnValueOnce(0);   // roll=1,  check3=false
      // cha 16 = mod 3, friendly, adjustedDcs: 10/12/14
      // check1: 19+3=22 >= 10 ✓
      // check2: 19+3=22 >= 12 ✓
      // check3: 1+3=4 < 14 ✗ (natural1 -> fail)
      const result = negotiate(16, 'friendly');
      expect(result.success).toBe(true);
      expect(result.passes).toBe(2);
      expect(result.totalChecks).toBe(3);
      expect(result.resultText).toContain('谈判成功');
      vi.restoreAllMocks();
    });

    it('fails with only 1 of 3 checks passed', () => {
      vi.spyOn(Math, 'random')
        .mockReturnValueOnce(0.9)  // roll=19, check1=true
        .mockReturnValueOnce(0)    // roll=1,  check2=false (natural1)
        .mockReturnValueOnce(0);   // roll=1,  check3=false (natural1)
      // cha 10 = mod 0, hostile, adjustedDcs: 17/19/21
      // check1: 19+0=19 >= 17 ✓
      // check2: natural1 ✗
      // check3: natural1 ✗
      const result = negotiate(10, 'hostile');
      expect(result.success).toBe(false);
      expect(result.passes).toBe(1);
      expect(result.resultText).toContain('谈判破裂');
      vi.restoreAllMocks();
    });
  });
});
