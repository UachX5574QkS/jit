import { TestBed } from '@angular/core/testing';
import { TextSizeService } from './text-size.service';

describe('TextSizeService', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('data-text-size');
    TestBed.configureTestingModule({});
  });

  afterEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('data-text-size');
  });

  it('defaults to medium and applies it to the document root', () => {
    const service = TestBed.inject(TextSizeService);
    expect(service.size()).toBe('medium');
    expect(document.documentElement.getAttribute('data-text-size')).toBe('medium');
  });

  it('sets and applies a chosen size', () => {
    const service = TestBed.inject(TextSizeService);
    service.setSize('large');
    expect(service.size()).toBe('large');
    expect(document.documentElement.getAttribute('data-text-size')).toBe('large');
  });

  it('ignores an invalid size, falling back to medium', () => {
    const service = TestBed.inject(TextSizeService);
    service.setSize('gigantic' as never);
    expect(service.size()).toBe('medium');
  });

  it('persists the chosen size to localStorage', () => {
    const service = TestBed.inject(TextSizeService);
    service.setSize('x-large');
    expect(localStorage.getItem('helpdesk.textSize')).toBe('x-large');
  });

  it('restores a persisted size on construction', () => {
    localStorage.setItem('helpdesk.textSize', 'small');
    const service = TestBed.inject(TextSizeService);
    expect(service.size()).toBe('small');
    expect(document.documentElement.getAttribute('data-text-size')).toBe('small');
  });
});
