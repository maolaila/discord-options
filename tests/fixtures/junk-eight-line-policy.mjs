// Historical fixture: retain the original 9/11 regression after production retires five lines.
import activePolicy from '../../config/zero-dte-options-policy.json' with { type: 'json' };
import experiment from './junk-eight-line-experiment.json' with { type: 'json' };
export default { ...activePolicy, exit_experiment: experiment };
