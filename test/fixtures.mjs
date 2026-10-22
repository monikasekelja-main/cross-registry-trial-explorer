// Synthetic examples; never used as a substitute for live source data.
export function ctgovRecord(id = 'NCT00000001') {
  return { protocolSection: {
    identificationModule: { nctId: id, briefTitle: 'Melanoma example trial' },
    conditionsModule: { conditions: ['Melanoma'] },
    statusModule: { overallStatus: 'RECRUITING', lastUpdatePostDateStruct: { date: '2026-10' } },
    sponsorCollaboratorsModule: { leadSponsor: { name: 'Example sponsor' } },
    contactsLocationsModule: { locations: [{ country: 'Italy' }] },
  }, hasResults: false };
}
export function ctisRecord(id = '2026-500001-01-00') {
  return { ctNumber: id, ctStatus: 'Authorised', authorizedApplication: {
    authorizedPartI: {
      trialDetails: { clinicalTrialIdentifiers: { publicTitle: 'Melanoma CTIS example' } },
      medicalConditions: [{ medicalCondition: 'Melanoma' }],
    },
    authorizedPartsII: [{ mscInfo: { countryName: 'Italy', reportingStatusCode: 'Authorised', hasRecruitmentStarted: false } }],
  } };
}
export function ctisSummary(id = '2026-500001-01-00') {
  return { ctNumber: id, ctTitle: 'Melanoma CTIS example', trialCountries: ['Italy:2'],
    conditions: 'Melanoma', lastUpdated: '21/10/2026', resultsFirstReceived: 'No' };
}
