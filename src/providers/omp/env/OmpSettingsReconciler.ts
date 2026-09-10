import { definePiFamilySettingsReconciler } from '../../pi-rpc/env/PiSettingsReconciler';
import { ompFamilyProfile } from '../profile';

export const ompSettingsReconciler = definePiFamilySettingsReconciler(ompFamilyProfile);
