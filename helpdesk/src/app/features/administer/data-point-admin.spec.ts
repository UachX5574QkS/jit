import { TestBed } from '@angular/core/testing';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { DataPointAdmin } from './data-point-admin';
import type { DataPointView } from './data-point-admin.service';
import { errorInterceptor } from '../../core/http/error.interceptor';

/**
 * Component tests for the Data Points screen (task 14.1; R14, R20.4). They
 * exercise: list data points, create one WITH the type-specific fields
 * (DROPDOWN options, REGEXP pattern; R14.2), and retire one (R14.3), with a
 * graceful message on a retirement failure.
 */

function point(overrides: Partial<DataPointView> = {}): DataPointView {
  return {
    id: 1,
    name: 'Cost Centre',
    dataType: 'TEXT',
    description: 'A finance code',
    defaultHelpText: null,
    regexpPattern: null,
    defaultOptions: null,
    isRetired: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('DataPointAdmin', () => {
  let httpMock: HttpTestingController;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [DataPointAdmin],
      providers: [
        provideHttpClient(withInterceptors([errorInterceptor])),
        provideHttpClientTesting(),
        provideRouter([]),
      ],
    }).compileComponents();
    httpMock = TestBed.inject(HttpTestingController);
  });

  /** Create the component and flush the initial data-points load. */
  function create(points: DataPointView[] = [point()]) {
    const fixture = TestBed.createComponent(DataPointAdmin);
    fixture.detectChanges();
    httpMock
      .expectOne((r) => r.url === '/api/admin/data-points' && r.method === 'GET')
      .flush({ dataPoints: points });
    fixture.detectChanges();
    return fixture;
  }

  type Comp = {
    newName: { set(v: string): void };
    newDataType: { set(v: string): void };
    newOptionsRaw: { set(v: string): void };
    newPattern: { set(v: string): void };
    needsOptions(): boolean;
    needsPattern(): boolean;
    canCreate(): boolean;
    createDataPoint(): void;
  };

  it('lists data points with type and shape (R14.1)', () => {
    const fixture = create([
      point({ id: 1, name: 'Environment', dataType: 'DROPDOWN', defaultOptions: ['Dev', 'Prod'] }),
      point({ id: 2, name: 'Ticket Ref', dataType: 'REGEXP', regexpPattern: '^[A-Z]{2}\\d+$' }),
    ]);
    const el = fixture.nativeElement as HTMLElement;
    const rows = el.querySelectorAll('.admin-table tbody tr.point-row');
    expect(rows.length).toBe(2);
    expect(rows[0].textContent).toContain('Environment');
    expect(rows[0].textContent).toContain('Dropdown');
    expect(rows[0].textContent).toContain('Dev, Prod');
    expect(rows[1].textContent).toContain('Regexp');
    expect(rows[1].querySelector('.shape-pattern')?.textContent).toContain('^[A-Z]{2}');
    httpMock.verify();
  });

  it('shows the options field only for DROPDOWN and the pattern field only for REGEXP (R14.2)', () => {
    const fixture = create([]);
    const c = fixture.componentInstance as unknown as Comp;

    c.newDataType.set('TEXT');
    fixture.detectChanges();
    expect(c.needsOptions()).toBe(false);
    expect(c.needsPattern()).toBe(false);

    c.newDataType.set('DROPDOWN');
    fixture.detectChanges();
    expect(c.needsOptions()).toBe(true);
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('textarea[name="options"]')).not.toBeNull();
    expect(el.querySelector('input[name="pattern"]')).toBeNull();

    c.newDataType.set('REGEXP');
    fixture.detectChanges();
    expect(c.needsPattern()).toBe(true);
    expect(el.querySelector('input[name="pattern"]')).not.toBeNull();
    expect(el.querySelector('textarea[name="options"]')).toBeNull();
    httpMock.verify();
  });

  it('creates a DROPDOWN data point with parsed options (R14.2)', () => {
    const fixture = create([]);
    const c = fixture.componentInstance as unknown as Comp;
    c.newName.set('Environment');
    c.newDataType.set('DROPDOWN');
    c.newOptionsRaw.set('Dev\nStaging\nProd\n');
    fixture.detectChanges();
    expect(c.canCreate()).toBe(true);

    c.createDataPoint();
    const req = httpMock.expectOne(
      (r) => r.url === '/api/admin/data-points' && r.method === 'POST',
    );
    expect(req.request.body).toEqual({
      name: 'Environment',
      dataType: 'DROPDOWN',
      description: null,
      defaultHelpText: null,
      regexpPattern: null,
      defaultOptions: ['Dev', 'Staging', 'Prod'],
    });
    req.flush(point({ id: 5, name: 'Environment', dataType: 'DROPDOWN', defaultOptions: ['Dev', 'Staging', 'Prod'] }));
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    expect(el.textContent).toContain('Environment');
    httpMock.verify();
  });

  it('creates a REGEXP data point with its pattern (R14.2)', () => {
    const fixture = create([]);
    const c = fixture.componentInstance as unknown as Comp;
    c.newName.set('Ticket Ref');
    c.newDataType.set('REGEXP');
    c.newPattern.set('^[A-Z]{2}\\d+$');
    fixture.detectChanges();
    expect(c.canCreate()).toBe(true);

    c.createDataPoint();
    const req = httpMock.expectOne(
      (r) => r.url === '/api/admin/data-points' && r.method === 'POST',
    );
    expect(req.request.body.dataType).toBe('REGEXP');
    expect(req.request.body.regexpPattern).toBe('^[A-Z]{2}\\d+$');
    expect(req.request.body.defaultOptions).toBeNull();
    req.flush(point({ id: 6, name: 'Ticket Ref', dataType: 'REGEXP', regexpPattern: '^[A-Z]{2}\\d+$' }));
    httpMock.verify();
  });

  it('blocks creation of a DROPDOWN with no options (R14.2)', () => {
    const fixture = create([]);
    const c = fixture.componentInstance as unknown as Comp;
    c.newName.set('Environment');
    c.newDataType.set('DROPDOWN');
    c.newOptionsRaw.set('   \n  ');
    fixture.detectChanges();
    expect(c.canCreate()).toBe(false);
    httpMock.verify();
  });

  it('retires a data point (R14.3)', () => {
    const fixture = create([point({ id: 1, isRetired: false })]);
    const el = fixture.nativeElement as HTMLElement;
    el.querySelector<HTMLButtonElement>('.btn-danger')!.click();

    const req = httpMock.expectOne(
      (r) => r.url === '/api/admin/data-points/1' && r.method === 'PATCH',
    );
    req.flush(point({ id: 1, isRetired: true }));
    fixture.detectChanges();

    expect(el.querySelector('.state-pill')?.textContent).toContain('Retired');
    expect(el.querySelector('.btn-danger')).toBeNull();
    httpMock.verify();
  });

  it('surfaces a retirement failure gracefully as a row message (R14.3)', () => {
    const fixture = create([point({ id: 1, isRetired: false })]);
    const el = fixture.nativeElement as HTMLElement;
    el.querySelector<HTMLButtonElement>('.btn-danger')!.click();

    const req = httpMock.expectOne(
      (r) => r.url === '/api/admin/data-points/1' && r.method === 'PATCH',
    );
    req.flush(
      { error: { code: 'NOT_FOUND', message: 'Data point not found.' } },
      { status: 404, statusText: 'Not Found' },
    );
    fixture.detectChanges();

    expect(el.querySelector('.row-message')).not.toBeNull();
    // Still active, no crash.
    expect(el.querySelector('.state-pill')?.textContent).toContain('Active');
    httpMock.verify();
  });
});
