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

export const isrctnXml = (id = 'ISRCTN12345678') => `<allTrials xmlns="http://www.67bricks.com/isrctn" totalCount="1"><fullTrial>
<trial publicIdentifierCanonical="${id}" lastUpdated="2026-10-24T12:00:00Z">
<trialDescription><title>Melanoma &amp; treatment</title></trialDescription>
<conditions><condition><description>Melanoma</description></condition></conditions>
<participants><recruitmentCountries><country>United Kingdom</country></recruitmentCountries><recruitmentStatusOverride>Recruiting</recruitmentStatusOverride></participants>
<interventions><intervention><drugNames>Example</drugNames><phase>Phase II</phase></intervention></interventions>
<externalRefs><secondaryNumbers><secondaryNumber numberType="nct">NCT00000001</secondaryNumber></secondaryNumbers></externalRefs>
<outputs><output outputType="basicresults"/></outputs>
</trial><sponsor><organisation>Example sponsor</organisation></sponsor></fullTrial></allTrials>`;
