import { definePiFamilySettingsReconciler } from '../../pi-rpc/env/PiSettingsReconciler';
import { piFamilyProfile } from '../profile';

export const piSettingsReconciler = definePiFamilySettingsReconciler(piFamilyProfile);
