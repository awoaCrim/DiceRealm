import { describe, expect, it } from 'vitest';
import {
  readSheetBoolean,
  readSheetNumber,
  readSheetString,
  readSheetStringArray,
  readSheetStringRecord,
} from './safeSheet';

describe('safeSheet', () => {
  it('读取合法 primitive 值', () => {
    const sheet = { name: '洛林', ac: 17, ready: true, equipment: ['剑', '盾'], abilities: { str: '15' } };
    expect(readSheetString(sheet, 'name')).toBe('洛林');
    expect(readSheetNumber(sheet, 'ac')).toBe(17);
    expect(readSheetBoolean(sheet, 'ready')).toBe(true);
    expect(readSheetStringArray(sheet, 'equipment')).toEqual(['剑', '盾']);
    expect(readSheetStringRecord(sheet, 'abilities')).toEqual({ str: '15' });
  });

  it('缺失与类型不符回退默认值', () => {
    expect(readSheetString(null, 'name')).toBe('');
    expect(readSheetNumber({}, 'ac')).toBe(0);
    expect(readSheetNumber({}, 'ac', 10)).toBe(10);
    expect(readSheetBoolean(undefined, 'ready')).toBe(false);
    expect(readSheetStringArray({ ac: 17 }, 'equipment')).toEqual([]);
    expect(readSheetStringRecord({ equipment: ['剑'] }, 'abilities')).toEqual({});
    expect(readSheetString({ ac: 17 }, 'name')).toBe('');
    expect(readSheetNumber({ name: 'x' }, 'ac')).toBe(0);
  });

  it('非有限数字回退', () => {
    expect(readSheetNumber({ ac: NaN }, 'ac')).toBe(0);
    expect(readSheetNumber({ ac: Infinity }, 'ac')).toBe(0);
  });

  it('string array 过滤非字符串元素', () => {
    const sheet = { spells: ['火球', 42, null, '治愈', { name: 'x' }] };
    expect(readSheetStringArray(sheet, 'spells')).toEqual(['火球', '治愈']);
  });

  it('恶意对象/原型字段安全回退，不抛异常', () => {
    const evil = JSON.parse('{"ac": 12, "__proto__": {"polluted": true}, "constructor": {"x": 1}}');
    expect(readSheetString(evil, 'toString')).toBe('');
    expect(readSheetStringArray(evil, 'equipment')).toEqual([]);
    expect(readSheetStringRecord(evil, 'abilities')).toEqual({});
    expect(readSheetStringRecord(evil, '__proto__')).toEqual({});
  });
});
