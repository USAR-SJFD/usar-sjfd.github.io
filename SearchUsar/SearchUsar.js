
// Global consts
const kstrFetchRigUrl = "https://script.google.com/macros/s/AKfycbzi08XGMRoHElsG0C3Yt0JsOUMuVI-6QJX6ZmuskLyd4TXHTabH9ypXcssipruJgN1p/exec?rig=";
const knAutosearchDelayMillis = 50;
const knMinimumSearchTextLen = 2;
const kstrRigSuffix = "-rig";
const kStrWhereSeparatorInternal = "\t";
const kStrWhereSeparatorUI = " : ";

// Global vars
var gMapRigContents = {};
var gnRefreshTimerID = null;
var gArrPendingRequests = [];
var gStrSearchText = "";
var gStrLastJson = "";



function init()
{
	const strSearchText = localStorage.getItem("searchText");
	const strEnabledRigsJSON = localStorage.getItem("enabledRigs");
	const arrEnabledRigs = strEnabledRigsJSON? JSON.parse(strEnabledRigsJSON) : [];
	
	for (const i in arrEnabledRigs)
	{
		const strRigLetter = arrEnabledRigs[i];
		const eltRigCheckbox = document.querySelector(`#RigToggles input[name="${strRigLetter}"]`);
		eltRigCheckbox.checked = true;
		getRigData(strRigLetter, true);  // true to bSuppressFetch (since batch fetching after this loop)
	}
	fetchRigDataIfNeeded();
	
	if (strSearchText)
	{
		const eltSearchInput = document.getElementById("SearchInput");
		eltSearchInput.value = strSearchText;
		searchText_saveValueAndRefresh(strSearchText, true);
	}
	
	// Header is floating fixed, so pad the rest of the content (Calls) down to just below header
	var nPageHeaderHeight = document.getElementById("PageHeader").offsetHeight;
	document.getElementById("HeadingSpacer").style.height = nPageHeaderHeight + "px";
	document.getElementById("ModalOverlay").style.top = nPageHeaderHeight + "px";
	var nOverlayHeight = document.getElementById("ModalOverlay").offsetHeight - nPageHeaderHeight;
	document.getElementById("AwaitResultsModal").style.height = nOverlayHeight + "px";
}


function updatePage()
{
	const strSearchTextLower = gStrSearchText.toLowerCase();
	const nSearchTextLen = strSearchTextLower.length;
	
	// Empty out results table elements
	const eltResultsTable = document.getElementById("ResultsTable");
	while (eltResultsTable.firstChild)
		eltResultsTable.removeChild(eltResultsTable.firstChild);
	
	// Restore scroll to top of window
	window.scrollTo({top: 0, left: 0, behavior: "smooth"});
	
	if (nSearchTextLen < knMinimumSearchTextLen)
		return;
	
	// Combine search results for all selected rigs
	const arrEnabledRigs = Object.keys(gMapRigContents);
	// Combine them in alphabetical rig order, so same-score results will be in that order after final sort
	arrEnabledRigs.sort();
	let arrResults = [];
	for (const i in arrEnabledRigs)
	{
		const strRigLetter = arrEnabledRigs[i];
		arrResults = arrResults.concat(searchRigContents(strRigLetter, strSearchTextLower));
	}
	
	// Sort results from highest to lowest score
	arrResults.sort((arrInfo1, arrInfo2) => arrInfo2[0] - arrInfo1[0]);
	
	// And rebuild results table...
	let strLastItemDescrLower = null;
	for (let i = 0; i < arrResults.length; i++)
	{
		const arrResult = arrResults[i];
		let [nScore, nMatchPos, strItemDescr, strWhere] = arrResult;
		
		const strItemDescrLower = strItemDescr.toLowerCase();
		if (strItemDescrLower == strLastItemDescrLower)
			strItemDescr = "";
		else
			strLastItemDescrLower = strItemDescrLower;
		
		if (strItemDescr && nMatchPos != -1)
			strItemDescr = strItemDescr.substr(0, nMatchPos) +
				'<span class="MatchText">' + strItemDescr.substr(nMatchPos, nSearchTextLen) +
				'</span>' + strItemDescr.substr(nMatchPos + nSearchTextLen);
		
		// FOR TESTING
		//if (strItemDescr) strItemDescr = `(${nScore})  ${strItemDescr}`;
		//if (strItemDescr) strItemDescr = `(${nMatchPos})  ${strItemDescr}`;
		
		strWhere = strWhere.replaceAll(kStrWhereSeparatorInternal, kStrWhereSeparatorUI);
		addSearchResultRow(eltResultsTable, strItemDescr, strWhere);
	}
}


function searchRigContents(strRigLetter, strSearchTextLower)
{
	var arrRigContents = gMapRigContents[strRigLetter];
	if (!arrRigContents?.length)
		return [];	// should only be possible if backend error
	
	var arrResults = [];
	for (var i = 0; i < arrRigContents.length; i++)
	{
		var arrItemInfo = arrRigContents[i];
		var strItemDescr = arrItemInfo[0].trim();  // this isn't trimmed by backend (for speed)
		var strItemDescrLower = strItemDescr.toLowerCase();
		var nMatchPos = strItemDescrLower.indexOf(strSearchTextLower);
		if (nMatchPos != -1)
		{
			const nScore = getResultScore(strSearchTextLower, strItemDescrLower, nMatchPos);
			var strWhere = arrItemInfo[1];  // this is already trim'med by backend
			strWhere = strRigLetter + kstrRigSuffix + kStrWhereSeparatorInternal + strWhere;
			arrResults.push([nScore, nMatchPos, strItemDescr, strWhere]);
		}
	}
	return arrResults;
}


function getResultScore(strSearchTextLower, strItemDescrLower, nMatchPos)
{
	// Handle unexpected result: search text not in item descr
	if (nMatchPos == -1)
		return 0;
	
	// Find search text's word offset within item descr
	var nLastSpacePos = -1;
	var nWordOffset = 0;
	for (var i = 0; i < nMatchPos; i++)
	{
		if (strItemDescrLower[i] == " ")
		{
			nWordOffset++;
			nLastSpacePos = i;
		}
	}
	
	var nScore;
	if (nLastSpacePos == (nMatchPos - 1))
	{
		// Match is at start of a word
		nScore = 1000 - nWordOffset*100;
		if (nScore < 100)
			nScore = -nScore / 10;
	}
	else
	{
		// Match is elsewhere within a word
		var nOffsetInWord = nMatchPos - nLastSpacePos;
		nScore = 500 - nWordOffset*50 - nOffsetInWord;
		if (nScore < 1)
			nScore = -nScore / 10;
	}
	
	// Reduce score overall position of match
	nScore -= nMatchPos;
	
	// Reduce score by number of letters after match within word
	var nMatchEndPos = nMatchPos + strSearchTextLower.length;
	var nMatchWordEndPos = strItemDescrLower.indexOf(" ", nMatchEndPos);
	if (nMatchWordEndPos == -1)
		nMatchWordEndPos = strItemDescrLower.length;
	nScore -= (nMatchWordEndPos - nMatchEndPos);
	
	// Reduce score by number of letters after match
	nScore -= (strItemDescrLower.length - nMatchEndPos);
	
	return nScore;
}


function addSearchResultRow(eltTable, strItemDescr, strWhere)
{
	var eltTR = document.createElement("tr");
	eltTR.className = "SearchResultRow";
	
	var eltTD1 = document.createElement("td");
	eltTD1.className = "ItemDescr";
	eltTD1.innerHTML = strItemDescr;
	
	var eltTD2 = document.createElement("td");
	eltTD2.className = "ItemWhere";
	eltTD2.innerHTML = strWhere;
	
	eltTR.appendChild(eltTD1);
	eltTR.appendChild(eltTD2);
	eltTable.appendChild(eltTR);
}


function getRigData(strRigLetter, bSuppressFetch)
{
	gMapRigContents[strRigLetter] = null;  // indicate this rig's data needs to be fetched
	if (!bSuppressFetch)
		fetchRigDataIfNeeded();
}


function fetchRigDataIfNeeded()
{
	let arrRigsNeeded = [];
	for (const strRigLetter in gMapRigContents)
		if (!gMapRigContents[strRigLetter])
			arrRigsNeeded.push(strRigLetter);
	
	if (arrRigsNeeded.length == 0)
		return;
	
	showModal("AwaitResultsModal");
	
	for (const i in arrRigsNeeded)
	{
		const strRigLetter = arrRigsNeeded[i];
		console.log(`Requesting rig contents for ${strRigLetter}${kstrRigSuffix}...`);
		
		const strFetchRigUrl = kstrFetchRigUrl + encodeURIComponent(strRigLetter);
		const objReq = new XMLHttpRequest();
		
		objReq.addEventListener("load", storeReceivedRigData);
		objReq.open("GET", strFetchRigUrl);
		objReq.setRequestHeader("Content-Type", "text/plain;charset=utf-8");  // to avoid Google Apps Script CORS restriction
		objReq.send();
		objReq.strRigLetter = strRigLetter;
		
		gArrPendingRequests.push(objReq);
	}
}


function storeReceivedRigData()
{
	const strRigLetter = this.strRigLetter;
	console.log(`Rig contents for ${strRigLetter}${kstrRigSuffix} received`);
	applyUpdatedRigData(strRigLetter, this);
}


function removeRigData(strRigLetterToRemove)
{
	strRigLetter = strRigLetterToRemove
	console.log(`Purging rig contents for ${strRigLetterToRemove}${kstrRigSuffix}`);
	delete gMapRigContents[strRigLetterToRemove];  // purge this rig's data, plus indicate it's no longer needed
	applyUpdatedRigData(strRigLetter);
}


function applyUpdatedRigData(strRigLetter, objResponse)
{
	// Remove given rig's request from pending requests (if present)
	const objRemovedReq = removeItemIf(gArrPendingRequests, objReq => (objReq.strRigLetter == strRigLetter));
	
	// If removed request is still open, abort it
	if (objRemovedReq && objRemovedReq.status == 0)
		objRemovedReq.abort();
	
	const nNumPending = gArrPendingRequests.length;
	if (nNumPending > 0)
		console.log(`...${nNumPending} rig contents request(s) still pending`);
	
	if (objResponse)
	{
		// Only store data if this rig is still needed (user may have unchecked
		// its checkbox while the fetch results were being awaited)
		if (strRigLetter in gMapRigContents)
		{
			const objResponseData = JSON.parse(objResponse.responseText);
			if (objResponseData)
			{
				const {rig: strRigLetter, contents: arrRigContents} = objResponseData;
				gMapRigContents[strRigLetter] = arrRigContents;
			}
		}
	}
	
	// Update UI if no more requests pending
	if (nNumPending == 0)
	{
		hideModal("AwaitResultsModal");
		updatePage();
	}
}


function removeItemIf(arr, fcn)
{
	for (const i in arr)
	{
		const item = arr[i];
		if (fcn(item))
		{
			arr.splice(i, 1);
			return item;
		}
	}
	return undefined;
}


function searchInput_onSubmit()
{
	var eltSearchInput = document.getElementById("SearchInput");
	searchText_saveValueAndRefresh(eltSearchInput.value, true);
	
	// Special case for iOS Safari: extra unfocus actions in order to make iOS keyboard dismiss
	document.activeElement.blur();
	eltSearchInput.blur();
	window.focus();
	
	window.event.preventDefault();
	return false;
}


// NOTE: Only handling onKeyDown to catch Enter key (since it doesn't generate onKeyUp event)
function searchInput_onKeyDown(eltSearchInput, evt)
{
	var ch = evt.which || evt.keyCode || evt.key.charCodeAt(0);

	if (ch === 13)
	{
		searchInput_onSubmit(eltSearchInput, evt)
		return false;
	}
	
	return true;
}


function searchInput_onKeyUp(eltSearchInput, evt)
{
	searchText_saveValueAndRefresh(eltSearchInput.value, false);
}


function searchText_saveValueAndRefresh(strVal, bImmediateRefresh)
{
	strVal = strVal.trim();
	if (!bImmediateRefresh && strVal == gStrSearchText)
		return;
	
	if (gnRefreshTimerID)
		clearTimeout(gnRefreshTimerID);
	
	gStrSearchText = strVal;
	localStorage.setItem("searchText", strVal);
	
	if (bImmediateRefresh)
		updatePage();
	else
		gnRefreshTimerID = setTimeout(updatePage, knAutosearchDelayMillis);
}


function rigSelect_onClick(eltRigCheckbox)
{
	const strRigLetter = eltRigCheckbox.name;
	if (eltRigCheckbox.checked)
		getRigData(strRigLetter);
	else
		removeRigData(strRigLetter);
	
	localStorage.setItem("enabledRigs", JSON.stringify(Object.keys(gMapRigContents)));
}


function showModal(strModalID)
{
	document.getElementById("ModalOverlay").style.display = "flex";
	document.getElementById(strModalID).style.display = "block";
}

function hideModal(strModalID)
{
	document.getElementById("ModalOverlay").style.display = "none";
	document.getElementById(strModalID).style.display = "none";
}


