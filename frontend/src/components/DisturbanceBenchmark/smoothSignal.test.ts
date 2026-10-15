import { describe, expect, it } from "vitest";
import { smoothPaths, smoothSignal } from "./smoothSignal";

const date = (day: number) =>
  new Date(Date.UTC(2022, 0, 1 + day)).toISOString().slice(0, 10);

describe("robust temporal trends", () => {
  it("reduces isolated endpoint drops without bridging a gap", () => {
    const points = Array.from({ length: 25 }, (_, i) => ({
      date: date(i * 5),
      value: i === 24 ? 0.1 : 0.8,
    }));
    points.push(
      { date: date(220), value: 0.2 },
      { date: date(225), value: 0.3 },
    );
    const trend = smoothSignal(points, 120, 45, false, true);
    expect(trend[0][trend[0].length - 1].value).toBeGreaterThan(0.7);
    expect(trend[1]).toEqual([]);
    expect(points[24].value).toBe(0.1);
  });
  it("preserves a sustained lower level after a gap", () => {
    const points = Array.from({ length: 24 }, (_, i) => ({
      date: date(i < 12 ? i * 5 : 150 + (i - 12) * 5),
      value: i < 12 ? 0.8 : 0.3,
    }));
    const trend = smoothSignal(points, 120, 45, false, true);
    expect(trend).toHaveLength(2);
    expect(trend[0].every((point) => Math.abs(point.value - 0.8) < 1e-6)).toBe(
      true,
    );
    expect(trend[1].every((point) => Math.abs(point.value - 0.3) < 1e-6)).toBe(
      true,
    );
  });
  it("draws a linear trend without repeated flat shoulders", () => {
    const segment = [0, 1, 3, 4].map((time) => ({
      date: String(time),
      time,
      value: 2 * time,
    }));
    const numbers = smoothPaths([segment], Number, (value) => value)[0]
      .match(/-?\d+(?:\.\d+)?/g)!
      .map(Number);
    for (let i = 0; i < numbers.length; i += 2) {
      expect(numbers[i + 1]).toBeCloseTo(2 * numbers[i]);
    }
  });
  it("keeps curve controls within fitted values across peaks and uneven dates", () => {
    const segment = [0, 1, 5, 6, 20].map((time, i) => ({
      date: String(time),
      time,
      value: [0, 0.7, 0.8, 0.2, 0.1][i],
    }));
    const curves = smoothPaths([segment], Number, (value) => value)[0]
      .split(" C ")
      .slice(1);
    curves.forEach((curve, i) => {
      const values = curve.replace(/,/g, "").split(" ").map(Number);
      const low = Math.min(segment[i].value, segment[i + 1].value);
      const high = Math.max(segment[i].value, segment[i + 1].value);
      [values[1], values[3]].forEach((value) => {
        expect(value).toBeGreaterThanOrEqual(low);
        expect(value).toBeLessThanOrEqual(high);
      });
    });
  });
  it("reduces an isolated spike without changing source observations", () => {
    const points = Array.from({ length: 41 }, (_, i) => ({
      date: date(i * 5),
      value: i === 20 ? -0.5 : 0.7,
    }));
    const smoothed = smoothSignal(points, 90, 45)[0];
    expect(smoothed[20].value).toBeGreaterThan(0.65);
    expect(points[20].value).toBe(-0.5);
  });
  it("retains annual seasonality and a sustained decline", () => {
    const points = Array.from({ length: 147 }, (_, i) => ({
      date: date(i * 5),
      value:
        0.6 + 0.2 * Math.sin((i * 5 * 2 * Math.PI) / 365) - (i >= 80 ? 0.3 : 0),
    }));
    const smoothed = smoothSignal(points, 90, 45)[0];
    expect(smoothed[18].value - smoothed[55].value).toBeGreaterThan(0.3);
    expect(smoothed[100].value).toBeLessThan(points[27].value - 0.2);
  });
  it("does not bridge long gaps or explicit missing Planet periods", () => {
    const points = [
      { date: date(0), value: 0.4 },
      { date: date(30), value: 0.5 },
      { date: date(60), value: null },
      { date: date(90), value: 0.6 },
      { date: date(250), value: 0.5 },
    ];
    expect(smoothSignal(points, 180, 100, true).map((s) => s.length)).toEqual([
      2, 1, 1,
    ]);
  });
  it("retains a monthly seasonal signal", () => {
    const points = Array.from({ length: 36 }, (_, i) => ({
      date: date(i * 30),
      value: 0.45 + 0.1 * Math.sin((i * 2 * Math.PI) / 12),
    }));
    const smoothed = smoothSignal(points, 180, 100, true)[0];
    expect(smoothed[15].value - smoothed[21].value).toBeGreaterThan(0.13);
  });
});
