
// Global consts
const kstrSearchUrl = "https://script.google.com/macros/s/AKfycbxw8U4EMW9tKyLKYrLbPvO06wH2nQwnjs-_xVAxmKzGeCx1yzoPqIAN65vcB3ITPbxP/exec?q=";
const knAutosearchDelayMillis = 800;

// Global vars
var gnRefreshTimerID = null;
var gObjPendingRequest = null;
var gStrSearchText = "";
var gStrLastJson = "";



function init()
{
	var eltSearchInput = document.getElementById("SearchInput");
	
	strSearchText = localStorage.getItem("searchText");
	if (strSearchText)
	{
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


function updatePage(objResponse)
{
	var strSearchTextLower = objResponse.searchText.trim().toLowerCase();
	var nSearchTextLen = strSearchTextLower.length;
	var arrResults = objResponse.results;
	
	// Empty out Results table
	var eltResultsTable = document.getElementById("ResultsTable");
	while (eltResultsTable.firstChild)
		eltResultsTable.removeChild(eltResultsTable.firstChild);
	
	// Insert score & match-pos into each result
	arrResults = arrResults.map(
		function(arrResultInfo)
		{
			var strItemDescrLower = arrResultInfo[0].toLowerCase();
			var nMatchPos = strItemDescrLower.indexOf(strSearchTextLower);
			return [getResultScore(strSearchTextLower, strItemDescrLower, nMatchPos), nMatchPos, ...arrResultInfo];
		});
	
	// Sort results from highest to lowest score
	arrResults.sort((arrInfo1, arrInfo2) => arrInfo2[0] - arrInfo1[0]);
	
	var strLastRow = null;
	var strLastItemDescrLower = null;
	
	for (var i = 0; i < arrResults.length; i++)
	{
		var arrResult = arrResults[i];
		var [nScore, nMatchPos, strItemDescr, arrItemWhere] = arrResult;
		
		var strItemDescrLower = strItemDescr.toLowerCase();
		if (strItemDescrLower == strLastItemDescrLower)
			strItemDescr = "";
		else
			strLastItemDescrLower = strItemDescrLower;
		
		arrItemWhere = arrItemWhere.map(str => str.replaceAll(" / ", "/"));  // improve readability
		removeConsecutiveRepeats(arrItemWhere);
		var strWhere = arrItemWhere.join(" : ");
		
		if (strItemDescr && nMatchPos != -1)
			strItemDescr = strItemDescr.substr(0, nMatchPos) +
				'<span class="MatchText">' + strItemDescr.substr(nMatchPos, nSearchTextLen) +
				'</span>' + strItemDescr.substr(nMatchPos + nSearchTextLen);
		
		// FOR TESTING
		//if (strItemDescr) strItemDescr = `(${nScore})  ${strItemDescr}`;
		//if (strItemDescr) strItemDescr = `(${nMatchPos})  ${strItemDescr}`;
		
		addSearchResultRow(eltResultsTable, strItemDescr, strWhere);
	}
}


function removeConsecutiveRepeats(arr)
{
	var prev = null;
	for (var i = 0; i < arr.length; i++)
	{
		curr = arr[i];
		if (curr == prev)
			arr.splice(i, 1);
		prev = curr;
	}
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
	
	if (nScore < 1)
		nScore = 1;
	
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


function refreshResults()
{
	showModal("AwaitResultsModal");
	console.log("Requesting search results...");
	
	var TESTING = false;
	//var TESTING = true;
	
	//############### FOR TESTING... ################
	if (TESTING)
	{
		var objResponse =
			{"searchText":"ladder",
			 "results": [
				["Step ladder",["USR-A","D3","Shelf / Section 1"]],
				["Rescue Ladder",["USR-A","D4","Shelf / Section 3","Box C"]],
				["Little Giant Ladder",["USR-A","D5","Shelf / Section 4","Box A"]],
				["Step ladder",["USR-A","P3","Shelf / Section 1"]],
				["Step Ladder",["USR-B","D2","Shelf / Section 6"]],
				["Folding Ladder",["USR-B","D5","Shelf / Section 5","Shelf / Section 5"]],
				["35 Foot, 3 Section Extension Ladder",["USR-B","Rear"]],
				["24 Foot, 2 Section Extension Ladder",["USR-B","Rear"]],
				["14 Foot, Roof Ladder (Hooks on both ends)",["USR-B","Rear"]],
				["14 Foot Extension Ladder (Fresno Ladder)",["USR-B","Rear"]],
				["10 Foot Atic Ladder",["USR-B","Rear"]]
			]};
		updateWithReceivedData(JSON.stringify(objResponse));
	}
	else
	{
		var objReq = new XMLHttpRequest();
		objReq.addEventListener("load", updateWithReceivedData);
		var strSearchUrl = kstrSearchUrl + encodeURIComponent(gStrSearchText);
		objReq.open("GET", strSearchUrl);
		objReq.setRequestHeader("Content-Type", "text/plain;charset=utf-8");  // to avoid Google Apps Script CORS restriction
		objReq.send();
		gObjPendingRequest = objReq;
	}
}


function updateWithReceivedData(strResponseJson)
{
	gObjPendingRequest = null;
	strResponseJson = this.responseText || strResponseJson;
	
	hideModal("AwaitResultsModal");
	
	if (strResponseJson === gStrLastJson)
		console.log("Received same as current data from back-end");
	else
	{
		var objResponse = JSON.parse(strResponseJson);
		gStrLastJson = strResponseJson;
		updatePage(objResponse);
	}
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
	if (gObjPendingRequest)
	{
		gObjPendingRequest.abort();
		gObjPendingRequest = null;
	}
	
	gStrSearchText = strVal;
	localStorage.setItem("searchText", strVal);
	
	if (bImmediateRefresh)
		refreshResults();
	else
		gnRefreshTimerID = setTimeout(refreshResults, knAutosearchDelayMillis);
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

