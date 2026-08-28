// Backward-compatible exports for callers introduced by P0-5.
// The implementation is now generic and supports S01-S06 through ShotProductionService.
export {
  ShotProductionService as S01ProductionService,
  ShotProductionError as S01ProductionError,
  createDefaultShotProductionService as createDefaultS01ProductionService,
} from './shotProductionService';

export type {
  ShotProductionRunInput as S01ProductionRunInput,
  ShotProductionRunResult as S01ProductionRunResult,
  ShotProductionShotRepository as S01ProductionShotRepository,
  ShotRunnerFactory as S01RunnerFactory,
  ShotProductionServiceLike as S01ProductionServiceLike,
  ShotIdentitySafeRunnerLike as S01IdentitySafeRunnerLike,
} from './shotProductionService';
