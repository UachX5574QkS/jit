import { currentUserFromDto, isRole, type CurrentUserDto } from './current-user.model';

function dto(overrides: Partial<CurrentUserDto> = {}): CurrentUserDto {
  return {
    id: 1,
    username: '11111111',
    displayName: 'Jason Hughes',
    roles: ['USER'],
    teamsLed: [],
    teamsMemberOf: [],
    isAdmin: false,
    timezone: null,
    ...overrides,
  };
}

describe('current-user.model', () => {
  describe('isRole', () => {
    it('accepts known role codes', () => {
      expect(isRole('USER')).toBe(true);
      expect(isRole('ADMINISTRATOR')).toBe(true);
    });

    it('rejects unknown values', () => {
      expect(isRole('SUPERUSER')).toBe(false);
      expect(isRole(42)).toBe(false);
      expect(isRole(null)).toBe(false);
    });
  });

  describe('currentUserFromDto', () => {
    it('converts roles into a Set for O(1) membership', () => {
      const user = currentUserFromDto(dto({ roles: ['USER', 'SUPPORT_MEMBER'] }));
      expect(user.roles.has('USER')).toBe(true);
      expect(user.roles.has('SUPPORT_MEMBER')).toBe(true);
      expect(user.roles.has('ADMINISTRATOR')).toBe(false);
    });

    it('ignores unknown role strings defensively', () => {
      const user = currentUserFromDto(dto({ roles: ['USER', 'WIZARD'] }));
      expect(user.roles.has('USER')).toBe(true);
      expect(user.roles.size).toBe(1);
    });

    it('keeps isAdmin consistent with the ADMINISTRATOR role', () => {
      const user = currentUserFromDto(dto({ roles: ['USER', 'ADMINISTRATOR'], isAdmin: false }));
      expect(user.isAdmin).toBe(true);
    });

    it('copies team id arrays', () => {
      const user = currentUserFromDto(dto({ teamsLed: [5], teamsMemberOf: [5, 6] }));
      expect(user.teamsLed).toEqual([5]);
      expect(user.teamsMemberOf).toEqual([5, 6]);
    });
  });
});
