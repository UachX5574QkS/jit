import type { GroupTarget, PasswordTarget } from '../types/api';

/**
 * Detects valid group break-glass combinations from a list of IDCS groups.
 *
 * A valid combination requires all three groups to be present:
 * - jit_<name>
 * - jit_<name>_approvers
 * - jit_<name>_elevated
 *
 * Validates: Requirements 3.1
 */
export function detectGroupCombinations(groups: string[]): GroupTarget[] {
  const groupSet = new Set(groups.map((g) => g.toLowerCase()));
  const results: GroupTarget[] = [];

  for (const group of groups) {
    const lower = group.toLowerCase();

    // Must start with 'jit_' and NOT end with '_approvers' or '_elevated'
    if (
      lower.startsWith('jit_') &&
      !lower.endsWith('_approvers') &&
      !lower.endsWith('_elevated')
    ) {
      const name = lower.slice('jit_'.length);
      const approversGroup = `jit_${name}_approvers`;
      const elevatedGroup = `jit_${name}_elevated`;

      if (groupSet.has(approversGroup) && groupSet.has(elevatedGroup)) {
        results.push({
          group_name: name,
          elevated_group: `jit_${name}_elevated`,
          approvers_group: `jit_${name}_approvers`,
        });
      }
    }
  }

  return results;
}

/**
 * Detects valid user password break-glass combinations from a list of IDCS groups.
 *
 * A valid combination requires all three groups to be present:
 * - inf_idcsuser_<name>
 * - inf_idcsuser_<name>_approvers
 * - inf_idcsuser_<name>_elevated
 *
 * Validates: Requirements 8.1
 */
export function detectUserCombinations(groups: string[]): PasswordTarget[] {
  const groupSet = new Set(groups.map((g) => g.toLowerCase()));
  const results: PasswordTarget[] = [];

  for (const group of groups) {
    const lower = group.toLowerCase();

    // Must start with 'inf_idcsuser_' and NOT end with '_approvers' or '_elevated'
    if (
      lower.startsWith('inf_idcsuser_') &&
      !lower.endsWith('_approvers') &&
      !lower.endsWith('_elevated')
    ) {
      const name = lower.slice('inf_idcsuser_'.length);
      const approversGroup = `inf_idcsuser_${name}_approvers`;
      const elevatedGroup = `inf_idcsuser_${name}_elevated`;

      if (groupSet.has(approversGroup) && groupSet.has(elevatedGroup)) {
        results.push({
          user_name: name,
          elevated_group: `inf_idcsuser_${name}_elevated`,
          approvers_group: `inf_idcsuser_${name}_approvers`,
        });
      }
    }
  }

  return results;
}

/**
 * Filters target combinations to only those the user is a member of.
 *
 * - For GroupTargets: keeps combinations where userGroups contains jit_<group_name>
 * - For PasswordTargets: keeps combinations where userGroups contains inf_idcsuser_<user_name>
 *
 * Validates: Requirements 3.2, 3.3, 8.2, 8.3
 */
export function filterByMembership<
  T extends { group_name?: string; user_name?: string },
>(combinations: T[], userGroups: string[]): T[] {
  const memberSet = new Set(userGroups.map((g) => g.toLowerCase()));

  return combinations.filter((combo) => {
    if (combo.group_name !== undefined) {
      return memberSet.has(`jit_${combo.group_name}`);
    }
    if (combo.user_name !== undefined) {
      return memberSet.has(`inf_idcsuser_${combo.user_name}`);
    }
    return false;
  });
}
