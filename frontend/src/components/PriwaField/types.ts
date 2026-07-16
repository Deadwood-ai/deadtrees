export interface IPriwaCoordinate {
  lat: number;
  lon: number;
}

export type PriwaCoordinateSource = "qr" | "gps" | "map";
export type PriwaGpsQuality = "ja" | "nein";
export type PriwaPointSyncOperation = "create" | "update" | "delete";
export type PriwaPointSyncStatus = "synced" | "pending" | "syncing" | "failed";
export type PriwaObserverName =
  | "Sigi Huber"
  | "Martin Schade"
  | "Maurice Mayer"
  | "Lukas Ruf"
  | "Markus Mayer"
  | "Stefan Treyer"
  | "Tobias Merz"
  | "Fabian Bohnert"
  | "andere";
export type PriwaFund = "ja" | "ja_kein_buchdrucker" | "nein" | "unsicher";
export type PriwaBaumart =
  | "Fichte"
  | "Tanne"
  | "Douglasie"
  | "Lärche"
  | "Kiefer"
  | "anderes Nadelholz"
  | "Laubholz";
export type PriwaYesNo = "ja" | "nein";
export type PriwaBohrloch = "ja" | "nein" | "ja_kein_buchdrucker";
export type PriwaHarz =
  | "vereinzelte Harztropfen"
  | "mittlerer/flächiger Harzfluss"
  | "nein";
export type PriwaNadel =
  | "grün"
  | "fahlgrün/gelblich"
  | "rot/braun"
  | "abgefallen";
export type PriwaPercentClass = "0%" | "bis25%" | "bis50%" | ">50%";
export type PriwaBefallsgruppeOrigin = "suggestion" | "manual";

export interface IPriwaPoint extends IPriwaCoordinate {
  id: string;
  baumnr: string;
  fund: PriwaFund;
  baumart: PriwaBaumart;
  bm: PriwaYesNo;
  bohrloch: PriwaBohrloch;
  harz: PriwaHarz;
  grueneNadelnAmBoden: PriwaYesNo;
  nadel: PriwaNadel;
  rinde: PriwaPercentClass;
  kv: PriwaPercentClass;
  name: PriwaObserverName;
  datum: string;
  kom: string;
  capturedAt: string;
  coordinateSource: PriwaCoordinateSource;
  gps: PriwaGpsQuality;
  isEstimatedLocation?: boolean;
  bhd?: number | null;
  fotoQrName?: string;
  rawQrValue?: string;
  syncStatus?: PriwaPointSyncStatus;
  syncOperation?: PriwaPointSyncOperation;
  syncError?: string;
}

export interface IPriwaBefallsgruppe {
  id: string;
  projectId: string;
  name: string;
  origin: PriwaBefallsgruppeOrigin;
  confidence: number | null;
  suggestionReason: string | null;
  algorithmVersion: string | null;
  treeIds: string[];
  datasetIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface IPriwaBefallsgruppeSaveInput {
  id?: string;
  name: string;
  origin: PriwaBefallsgruppeOrigin;
  confidence?: number | null;
  suggestionReason?: string | null;
  algorithmVersion?: string | null;
  treeIds: string[];
  datasetIds: string[];
}
