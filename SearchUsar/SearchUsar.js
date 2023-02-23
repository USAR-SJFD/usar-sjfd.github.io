
// Global consts
const SERVER_BASE_URL = "https://script.google.com/macros/s/AKfycbytMMnE21-8BJzwQs55qjAD0WhwAXvmWKp62zkk1xZDY4bjOfedFSYG3UWQa9xHlo96/exec";
const FETCH_PARAMS = {cache: 'no-store'};

const SERVERVERSION_STORAGE_KEY = "ServerVersion";
const SELECTEDRIGS_STORAGE_KEY = "SelectedRigs";
const SEARCHTEXT_STORAGE_KEY = "SearchText";
const INVENTORYCACHE_STORAGE_KEY = "InventoryCache";
const LOCATIONPICSMAP_STORAGE_KEY = "LocationPicsMap";
const LASTREQUESTTIME_STORAGE_KEY = "LastRequestTime";

const knMinimumSearchTextLen = 2;
const kStrInternalSeparator = "\t";
const kStrRecordSeparator = "␞";           // 'record separator' (unicode 9246)
const kStrWhereSeparator = " ≫ ";          // 'much greater-than' (unicode 8811)
//const kStrWhereSeparator = " ▻ ";
//const kStrWhereSeparator = " ➤ ";
//const kStrWhereSeparator = " ⨠ ";
//const kStrWhereSeparator = "&thinsp;➝ ";
//const kStrWhereSeparator = "&thinsp;➛ ";

const REM_PX = parseFloat(getComputedStyle(document.documentElement).fontSize);
const SUPPRESS_EVENT = evt => evt.preventDefault();


// Global vars
var gObjInventoryInfo = null;		// will contain {cacheModTime, rigButtonsMap, rigInventoriesMap}
var gbPendingUpdateFetch = false;
var gbPendingDelayedUpdateFetch = false;
var gbPendingUpdateUI = false;
var gArrRigButtonNames = [];
var gArrCheckedButtonNames = [];

var gMapLocationPics = {};
var gMapRigCheckboxes = {};    // will contain {<buttonName>: <eltCheckbox>, ...}
var gStrSearchText = "";
var gObjRigSelectMouseDown = {};
var gEltLinksMenuShownFor = null;


function init()
{
	if (localStorage.getItem(SERVERVERSION_STORAGE_KEY) !== SERVER_BASE_URL)
	{
		localStorage.setItem(SERVERVERSION_STORAGE_KEY, SERVER_BASE_URL);
		console.log("Clearing local cache because server version has been updated");
		return clearCache();  // this causes reload		
	}
	
	const strInventoryInfo = localStorage.getItem(INVENTORYCACHE_STORAGE_KEY);
	gObjInventoryInfo = strInventoryInfo && parseCombinedInventoryText(strInventoryInfo);
	updateRigToggles();
	fetchUpdateIfNeeded();
	
	const strLocationPicsJSON = localStorage.getItem(LOCATIONPICSMAP_STORAGE_KEY);
	gMapLocationPics = (strLocationPicsJSON && safeJsonParse(strLocationPicsJSON)) || {};

	// Briefly delay getLocationPics request to minimize server flooding (and since it's a lower priority update)
	setTimeout(() => {
		console.log("Server request: 'getLocationPics' (location pictures map)...");
		serverRequest("getLocationPics");
	}, 500);
	
	const strSearchText = localStorage.getItem(SEARCHTEXT_STORAGE_KEY);
	if (strSearchText)
	{
		const eltSearchInput = document.getElementById("SearchInput");
		eltSearchInput.value = strSearchText;
		searchText_saveValueAndRefresh(strSearchText);
	}
	
	// Header is floating fixed, so pad the rest of the content (search results) down to just below header
	var nPageHeaderHeight = document.getElementById("PageHeader").offsetHeight;
	document.getElementById("HeadingSpacer").style.height = nPageHeaderHeight + "px";
	document.getElementById("LoadingModal").style.top = nPageHeaderHeight + "px";
	
	// To handle click-and-drag/touch-and-drag (used for rigSelect buttons)
	window.addEventListener("mousemove", rigSelect_onMouseOver, {capture: true});
	window.addEventListener("touchmove", rigSelect_onMouseOver, {capture: true});
	window.addEventListener("mouseup", rigSelect_onMouseUp, {capture: true});
	window.addEventListener("touchend", rigSelect_onMouseUp, {capture: true});
	
	// To handle "clicking out of" links menu
	window.addEventListener("mousedown", maybeDismissLinksMenu);
	window.addEventListener("touchstart", maybeDismissLinksMenu);

	updateUIMode();
	updateSearchResults();
}


function fetchUpdateIfNeeded()
{
	// Don't request again while a prior request is still pending, or a delayed request timer is pending
	if (gbPendingUpdateFetch || gbPendingDelayedUpdateFetch)
		return;
	
	// Throttle requests so as not to flood server, to reduce chance of Google Drive API "Rate Limit Exceeded" error
	const now = Date.now();
	const strLastRequestTime = localStorage.getItem(LASTREQUESTTIME_STORAGE_KEY);
	const nLastRequestTime = strLastRequestTime? parseInt(strLastRequestTime) : 0;
	const nMillisSinceLastRequest = now - nLastRequestTime;
	
	// If it's been less than 1 second since prior update request, wait till get to 1 second to request again
	if (nMillisSinceLastRequest < 1000)
	{
		console.log("Throttling server request (max 1 per second)");
		const nMillisToOneSecond = 1000 - nMillisSinceLastRequest;
		gbPendingDelayedUpdateFetch = true;
		setTimeout(() => {
			gbPendingDelayedUpdateFetch = false;
			fetchUpdateIfNeeded();
		}, nMillisToOneSecond);
		return;
	}
	
	localStorage.setItem(LASTREQUESTTIME_STORAGE_KEY, String(now));
	gbPendingUpdateFetch = true;
	
	const strCacheModTime = gObjInventoryInfo?.cacheModTime;
	if (strCacheModTime)
	{
		// We have local cache; silently check for update, only showing update modal if isUpdateNeeded responds true
		console.log("Server request: 'getIfNeeded' (inventory content)...");
		serverRequest("isUpdateNeeded", strCacheModTime);
		// Briefly delay this second request to (1) minimize server flooding, and (2) give server a chance to
		// cache and reuse date-checking info
		setTimeout(() => serverRequest("getIfNeeded", strCacheModTime), 250);
	}
	else
	{
		// We don't have local cache; show update modal and fetch update
		console.log("Server request: 'get' (inventory content)...");
		serverRequest("get");
		gbPendingUpdateUI = true;
		updateUIMode();
	}
}


function serverRequest(strRequestAction, strCacheModTime)
{
	//gnResponsesPending++;
	const strUrl = strCacheModTime?
		`${SERVER_BASE_URL}?action=${strRequestAction}&clientCacheModTime=${strCacheModTime}` :
		`${SERVER_BASE_URL}?action=${strRequestAction}`;
	fetch(strUrl, FETCH_PARAMS)
		.then(response => handleServerResponse(strRequestAction, response))
		.catch(err => handleServerResponse(strRequestAction, null, err));
}


async function handleServerResponse(strRequestAction, response, err)
{
	const bIsInventoryResponse = strRequestAction === "get" || strRequestAction === "getIfNeeded";
	const parser = bIsInventoryResponse? parseCombinedInventoryText : safeJsonParse;
	
	//gnResponsesPending = Math.max(0, gnResponsesPending - 1);
	if (bIsInventoryResponse && gbPendingUpdateFetch)
	{
		gbPendingUpdateFetch = false;
		gbPendingUpdateUI = false;
		updateUIMode();
	}
	
	if (err)
		showServerError(err.message);
	else if (!response.ok)
		showServerError(`${response.statusText} (code ${response.status})`);
	else
	{
		const strResponseText = await response.text();
		const objResponseValue = parser(strResponseText);
		
		if (objResponseValue === undefined)
			showServerError(`Unable to parse server's '${strRequestAction}' response ("${strResponseText}")`);
		
		else if (objResponseValue.error)
			showServerError(objResponseValue.error);
		
		else switch (strRequestAction)
		{
			case "isUpdateNeeded":
				if (objResponseValue === false)
					console.log("--> Server response: no update needed (inventory content)");
				else if (gbPendingUpdateFetch)
				{
					console.log("--> Server response: update needed (inventory content); awaiting 'getIfNeeded' response");
					gbPendingUpdateUI = true;
					updateUIMode();
				}
				else
				{
					console.log("--> Server response: update needed (inventory content); already received 'getIfNeeded' response");
					// We received the 'getIfNeeded' response before the 'isUpdateNeeded' response, so we never
					// put the UI in update mode; do it now briefly just so user knows an update happened
					showUpdateUI(1000);
				}
				break;
			
			case "getIfNeeded":
			case "get":
				if (objResponseValue?.rigInventoriesMap)
				{
					gObjInventoryInfo = objResponseValue;
					console.log(`--> Server response: update received (inventory content); modTime ${gObjInventoryInfo.cacheModTime}`);
					localStorage.setItem(INVENTORYCACHE_STORAGE_KEY, strResponseText);
					updateRigToggles();
					updateUIMode();
					updateSearchResults();
				}
				break;
			
			case "getLocationPics":
				updateLocationPicsMapIfNeeded(strResponseText, objResponseValue);
				break;
		}
	}
}


function updateLocationPicsMapIfNeeded(strLocationPicsJSON, mapLocationPics)
{
	if (localStorage.getItem(LOCATIONPICSMAP_STORAGE_KEY) === strLocationPicsJSON)
	{
		console.log("--> Server response: no update needed (location pictures map)");
		return;
	}
	
	console.log("--> Server response: update received (location pictures map)");
	localStorage.setItem(LOCATIONPICSMAP_STORAGE_KEY, strLocationPicsJSON);
	gMapLocationPics = mapLocationPics;
	updateSearchResults();
	
	// Briefly put the UI in update mode so user knows an update happened
	showUpdateUI(1000);
}


function arrayEquals(arr1, arr2)
{
	return arr1 && arr2 && arr1.length === arr2.length && arr1.every((val, i) => (val === arr2[i]));
}


function updateRigToggles()
{
	// Get the rig button names in alphabetical order
	const mapRigButtons = gObjInventoryInfo?.rigButtonsMap;
	const arrRigButtonNames = mapRigButtons? Object.keys(mapRigButtons) : [];
	arrRigButtonNames.sort();
	
	// If don't yet have buttons map, or the list of buttons hasn't changed, then nothing to update
	if (arrRigButtonNames.length === 0 || arrayEquals(arrRigButtonNames, gArrRigButtonNames))
		return;
	
	gArrRigButtonNames = arrRigButtonNames;
	
	const strCheckedButtonNamesJSON = localStorage.getItem(SELECTEDRIGS_STORAGE_KEY);
	gArrCheckedButtonNames = (strCheckedButtonNamesJSON && safeJsonParse(strCheckedButtonNamesJSON)) || [];
	const eltRigTogglesDiv = document.getElementById("RigToggles");
	
	// Remove all current rig toggles
	gMapRigCheckboxes = {};
	while (eltRigTogglesDiv.firstChild)
		eltRigTogglesDiv.removeChild(eltRigTogglesDiv.lastChild);
    
	// Create the specified rig toggles
	console.log(`Rig buttons: [${gArrRigButtonNames}]; checked: [${gArrCheckedButtonNames}]`);
	for (const strButtonName of gArrRigButtonNames)
	{
		// Ensure only one toggle per rig (in case of erroneous backend data)
		if (strButtonName in gMapRigCheckboxes)
			continue;
		
		// Build this element structure for each toggle:
		//   <label>
		//      <input type="checkbox" name="A" onclick="rigSelect_onClick(this)" />
		//      <span>A</span>
		//	 </label>
		const eltLabel = document.createElement("LABEL");
		const eltInput = document.createElement("INPUT");
		const eltSpan = document.createElement("SPAN");
		
		eltInput.setAttribute("type", "checkbox");
		eltInput.setAttribute("name", strButtonName);
		
		// To initiate click-and-drag/touch-and-drag started on a rigSelect button
		eltLabel.onmousedown = rigSelect_onMouseDown;
		eltLabel.ontouchstart = rigSelect_onMouseDown;
		
		// Suppress the standard click/mousedown/touchstart behavior
		eltLabel.onclick = eltInput.onclick = eltInput.onmousedown = eltInput.ontouchstart = SUPPRESS_EVENT;
		
		eltSpan.appendChild(document.createTextNode(strButtonName));
		eltLabel.appendChild(eltInput);
		eltLabel.appendChild(eltSpan);
		eltRigTogglesDiv.appendChild(eltLabel);
		gMapRigCheckboxes[strButtonName] = eltInput;
		if (gArrCheckedButtonNames.includes(strButtonName))
			eltInput.checked = true;
	}
}


function updateSearchResults()
{
	const arrCheckedButtonNames = Object.values(gMapRigCheckboxes).filter(elt => elt.checked).map(elt => elt.name);
	var arrResults = [];

	if (arrCheckedButtonNames.length > 0 && gStrSearchText.length >= knMinimumSearchTextLen)
	{
		const strDistilledLowerSearchText = distillSearchText(gStrSearchText);
		if (strDistilledLowerSearchText)
		{
			// Primary regex is case-[i]nsensitive, [m]ulti-line (to treat each line as separate match-target), 
			// and [g]lobal (to find all matching lines, not just the first)
			const searchRegex = buildSearchRegex(strDistilledLowerSearchText, "img");
			const searchWhereRegex = buildSearchRegex(strDistilledLowerSearchText, "i", true);
			
			console.log(searchRegex);
			console.log(searchWhereRegex);
			
			// Combine search results for all selected rigs
			var bMatchesInItem = false;
			var bMatchesInWhere = false;
			for (const strButtonName of arrCheckedButtonNames)
			{
				//arrResults = arrResults.concat(searchRigContents(strButtonName, strSearchTextLower));
				const arrRigResults = searchRigContents(strButtonName, searchRegex, searchWhereRegex);
				arrResults = arrResults.concat(arrRigResults);
				bMatchesInItem ||= arrRigResults.bMatchesInItem;
				bMatchesInWhere ||= arrRigResults.bMatchesInWhere;
			}
			//console.log(`IN ITEMS?  ${bMatchesInItem}   IN WHERES?  ${bMatchesInWhere}`);
			
			// Sort results from highest to lowest score, by item description if same score,
			// and by location if same item description
			arrResults.sort(matchSortOrder);
			
			// Split results in those that matched only in the "where" section, and all others
			var arrResultsInWhere = arrResults.filter(match => (match.bMatchInWhere && !match.bMatchInItem));
			var arrResultsOther = arrResults.filter(match => !(match.bMatchInWhere && !match.bMatchInItem));
			
			const nNumResultsInWhere = arrResultsInWhere.length;
			const nNumResultsOther = arrResultsOther.length;
			
			var nScoreInWhere = 0; for (const match of arrResultsInWhere) nScoreInWhere += match.nScore;
			var nScoreOther = 0; for (const match of arrResultsOther) nScoreOther += match.nScore;
			
			const nAvgScoreInWhere = nNumResultsInWhere && (nScoreInWhere / nNumResultsInWhere);
			const nAvgScoreOther = nNumResultsOther && (nScoreOther / nNumResultsOther);
			
			//console.log(`NUM IN WHERE: ${nNumResultsInWhere}   AVG SCORE: ${nAvgScoreInWhere}`)
			//console.log(`   NUM OTHER: ${nNumResultsOther}   AVG SCORE: ${nAvgScoreOther}`)
		}
	}
	
	rebuildSearchResultsTable(arrResults);
}


// Sort results from highest to lowest score, by item description if same score,
// and by location if same item description
function matchSortOrder(match1, match2)
{
	const nRelScore = match2.nScore - match1.nScore;
	if (nRelScore !== 0)
		return nRelScore;

	if (match2.strItemDescr < match1.strItemDescr)
		return 1;
	if (match2.strItemDescr > match1.strItemDescr)
		return -1;

	if (match2.strWhere < match1.strWhere)
		return 1;
	if (match2.strWhere > match1.strWhere)
		return -1;

	return 0;
}


function rebuildSearchResultsTable(arrResults)
{
	// Empty out results table elements
	const eltResultsTable = document.getElementById("ResultsTable");
	while (eltResultsTable.firstChild)
		eltResultsTable.removeChild(eltResultsTable.firstChild);
	
	// Restore scroll to top of window
	window.scrollTo({top: 0, left: 0, behavior: "smooth"});
	
	// Keep track of prev row's values, to detect when values repeat on consecutive lines
	var strPrevItemDescrLower = null;
	var strPrevWhereLower = null;
	var eltPrevItemQuantity = null;
	var eltFirstGroupedItemQuantity = null;
	var nTotalGroupedItemQuantity = 0;
	
	for (let i = 0; i < arrResults.length; i++)
	{
		const {nScore, nQuantity, strItemDescr, strWhere, strItemInfo} = arrResults[i];
		const strItemDescrLower = strItemDescr.toLowerCase();
		const strWhereLower = strWhere.toLowerCase();
		const bSameAsPrevItem = (strItemDescrLower === strPrevItemDescrLower);
		const bSameAsPrevWhere = (strWhereLower === strPrevWhereLower);
		strPrevItemDescrLower = strItemDescrLower;
		strPrevWhereLower = strWhereLower;
		
		if (bSameAsPrevItem)
		{
			// Still in "grouped item" (same item across multiple locations)
			nTotalGroupedItemQuantity += nQuantity;
			if (bSameAsPrevWhere)
			{
				// Same item & same location, so don't add new row; just update existing row's quantity
				incrementQuantity(eltPrevItemQuantity, nQuantity);
				continue;
			}
		}
		else
		{
			// At a new item; close out the previous "grouped item" if needed
			if (eltPrevItemQuantity && eltPrevItemQuantity !== eltFirstGroupedItemQuantity)
				setGroupedItemTotalQuantity(eltFirstGroupedItemQuantity, nTotalGroupedItemQuantity);
			
			// Consider this new item potentially the start of a new "grouped item"
			nTotalGroupedItemQuantity = nQuantity;
		}
		
		
		const eltItemDescr = document.createElement("SPAN");
		eltItemDescr.className = "ItemDescr";
		if (!bSameAsPrevItem)
		{
			eltItemDescr.innerHTML = strItemDescr;
			//eltItemDescr.innerHTML = strItemDescr? `(${nScore})  ${strItemDescr}` : "";  // ***FOR DEBUGGING***
			
			if (strItemInfo)
			{
				eltItemDescr.setAttribute("data-links", strItemInfo);
				eltItemDescr.onclick = itemDescr_onClick;
			}
		}
		
		const eltItemQuantity = document.createElement("SPAN");
		eltItemQuantity.className = "Quantity";
		eltItemQuantity.setAttribute("data-quantity", nQuantity);
		
		const eltTD1 = document.createElement("TD");
		if (bSameAsPrevItem)
			eltTD1.className = "NoLine";
		eltTD1.appendChild(eltItemDescr);
		eltTD1.appendChild(eltItemQuantity);
		
		const eltTD2 = document.createElement("TD");
		eltTD2.className = "ItemWhere";
		if (bSameAsPrevWhere)
			eltTD2.className = "NoLine";
		else
			eltTD2.innerHTML = styleWhere(strWhere);
		
		const eltTR = document.createElement("TR");
		eltTR.className = "SearchResultRow";
		eltTR.appendChild(eltTD1);
		eltTR.appendChild(eltTD2);
		eltResultsTable.appendChild(eltTR);
		
		eltPrevItemQuantity = eltItemQuantity;
		if (!bSameAsPrevItem)
			eltFirstGroupedItemQuantity = eltItemQuantity;
	}
	
	// Close out the last "grouped item" if needed
	if (eltPrevItemQuantity && eltPrevItemQuantity !== eltFirstGroupedItemQuantity)
		setGroupedItemTotalQuantity(eltFirstGroupedItemQuantity, nTotalGroupedItemQuantity);
}


function incrementQuantity(eltItemDescr, nAddedQuantity)
{
	const strQuantity = eltItemDescr.getAttribute("data-quantity");
	const nQuantity = strQuantity? parseInt(strQuantity) : 1;
	eltItemDescr.setAttribute("data-quantity", nQuantity + nAddedQuantity);
}


function setGroupedItemTotalQuantity(eltFirstGroupedItemQuantity, nTotalGroupedItemQuantity)
{
	eltFirstGroupedItemQuantity.setAttribute("data-total-quantity", nTotalGroupedItemQuantity);
	eltFirstGroupedItemQuantity.className = "Quantity FirstGrouped";
}


function distillSearchText(strSearchText)
{
	var strSearchText = strSearchText.toLowerCase();
	strSearchText = strSearchText.replace(/[.,+'\/\\()|]/g, "-");   // treat these same as a hyphen
	strSearchText = strSearchText.replace(/[^a-z0-9 &\-"]/ig, " "); // keep only letters, numbers, spaces, &, -, "
	strSearchText = strSearchText.replace(/(?: -|- )/g, " ");       // treat hyphen next to a space as just a space
	strSearchText = strSearchText.replace(/\s+/g, " ").trim();      // single space only; no leading/trailing space
	
	// Within quoted section, a space matches one non-word char (use '_' as placeholder for that)
	strSearchText = strSearchText.replace(/"([^"]*)(?:"|$)/g, (m, group1) => group1.trim().replaceAll(" ", "_"));
	strSearchText = strSearchText.trim();
	console.log('"' + strSearchText + '"');
	if (strSearchText.length < knMinimumSearchTextLen || !/[a-z0-9]{2}/.test(strSearchText))
		return null;
	else
		return strSearchText;
}


function buildSearchRegex(strDistilledLowerSearchText, strRegexFlags, bForWhereSection)
{
	// Special case to allow abbreviated search term for "Shelf/Section"
	var strSearchPattern = strDistilledLowerSearchText.replace(/\bshelf\b(?![^a-z0-9]+section\b)/g, "shelf(?:/section)?");

	if (bForWhereSection)
	{
		// For searching the "where" section, special case for (box|shelf|section|unit) followed by
		// a number or single letter after a space: treat that space like it's in a quoted section
		// and require the phrase to match only on word boundaries
		// (note: for "section", also optionally detect special case added above)
		var strWhereSearchPattern =
			strSearchPattern.replace(/\b(box|shelf|section(?:\)\?)?|unit)[ \-](\d+|[a-z])\b/g, "\\b$1_$2\\b");
		
		// Similar special case for the phrase "[letter] (rig|hauler|trailer)"
		// (note: Safari doesn't support negative lookbehind in regex, so have to capture char before)
		strWhereSearchPattern =
			strWhereSearchPattern.replace(/(^|[^\\])\b([a-z])[ \-](rig|hauler|trailer)\b/g, "$1\\b$2_$3\\b");
		
		// And finally, special case for single letter on its own: require it to match only on word boundaries
		// (note: Safari doesn't support negative lookbehind in regex, so have to capture char before)
		strWhereSearchPattern =
			strWhereSearchPattern.replace(/(^|[^\\])\b([a-z])\b(?!_)/g, "$1\\b$2\\b");
		
		// If special case doesn't occur in given search string, return null to indicate no special case needed
		if (strWhereSearchPattern === strDistilledLowerSearchText)
			return null;
		else
			strSearchPattern = strWhereSearchPattern;
	}
	
	// A hyphen matches zero or one non-word char -- i.e. replace each hyphen with pattern [^a-z0-9\n]?
	strSearchPattern = strSearchPattern.replaceAll("-", "[^a-z0-9\n]?");
	
	// A space within a quoted section (represented in strDistilledLowerSearchText by the placeholder '_')
	// matches one non-word char -- i.e. replace each '_' with pattern [^a-z0-9\n]
	strSearchPattern = strSearchPattern.replaceAll("_", "[^a-z0-9\n]");
	
	//// Remove any single-letter words that aren't within a quoted section or next to a hyphen
	//strSearchPattern = strSearchPattern.replace(/(?:^| )[a-z](?: |$)/g, "");
	
	// Any other space matches any non-empty string -- i.e. replace each remaining space with pattern .+?
	// and enclose preceding & following chars in group parens, plus enclose skipped chars in group parens
	strSearchPattern = strSearchPattern.replaceAll(" ", ")(.+?)(");
	
	// Finally, skip over initial 'record' (rig & quantity info), and add initial and final group parentheses
	strSearchPattern = `^([^${kStrRecordSeparator}]*${kStrRecordSeparator}.*?)(${strSearchPattern})`;
	
	return new RegExp(strSearchPattern, strRegexFlags);
}


function searchRigContents(strButtonName, searchRegex, searchWhereRegex)
{
	const arrRigs = gObjInventoryInfo?.rigButtonsMap?.[strButtonName];
	if (!arrRigs)
		return [];
	
	let arrResults = [];
	let bMatchesInItem = false;
	let bMatchesInWhere = false;
	
	for (const objRigInfo of arrRigs)
	{
		const strRigContents = gObjInventoryInfo?.rigInventoriesMap?.[objRigInfo.rigName];
		if (!strRigContents?.length)
			continue;
		
		searchRegex.lastIndex = 0;
		let nLineEnd = -1;
		let match;
		while ((match = searchRegex.exec(strRigContents)) !== null)
		{
			let strOverallMatch = match[0];
			let nMatchStart = match.index;
			let nMatchEnd = nMatchStart + strOverallMatch.length;
			
			nLineStart = nMatchStart;  // nMatchStart is always start of line, since regex begins with '^'
			let nLineEnd = strRigContents.indexOf("\n", nMatchEnd);
			if (nLineEnd === -1)
				nLineEnd = strRigContents.length;
			
			// Extract the line being matched
			const strLine = strRigContents.substring(nLineStart, nLineEnd);
			// Then make nMatchStart point to first match part relative to line -- i.e. skip
			// over first group, which contains all the chars before the first match part
			nMatchStart = match[1].length;
			// And also adjust nMatchEnd relative to line
			nMatchEnd -= nLineStart;
			
			const nItemInfoEnd = strLine.indexOf(kStrRecordSeparator);
			const nItemStart = nItemInfoEnd + kStrRecordSeparator.length;
			const nItemEnd = strLine.indexOf(kStrRecordSeparator, nItemStart);
			const nWhereStart = nItemEnd + kStrRecordSeparator.length;
			const bMatchInItem = nMatchStart < nWhereStart;
			const bMatchInWhere = nMatchEnd >= nWhereStart;
			bMatchesInItem ||= bMatchInItem;
			bMatchesInWhere ||= bMatchInWhere;
			
			// Extract the quantity and item info, if any present
			let strQuantity = null;
			let strItemInfo = strLine.substr(0, nItemInfoEnd);
			if (strItemInfo)
			{
				// Check for JSON after quantity string
				let nJsonStart = strItemInfo.indexOf("[");
				if (nJsonStart === -1)
					nJsonStart = strItemInfo.indexOf("{");
				if (nJsonStart !== -1)
				{
					strQuantity = strItemInfo.substring(0, nJsonStart);
					strItemInfo = strItemInfo.substring(nJsonStart);
				}
				else
				{
					strQuantity = strItemInfo;
					strItemInfo = null;
				}
			}
			
			if (bMatchInWhere && searchWhereRegex)
			{
				const whereRegexMatch = searchWhereRegex.exec(strLine);
				if (whereRegexMatch)
				{
					match = whereRegexMatch;
					nMatchStart = match[1].length;
				}
				else if (!bMatchInItem)
					// If the match is only in where, and searchWhereRegex doesn't succeed
					// then treat this item as a non-match
					continue;
			}
			
			//const SHOWITEM = "Screamer Suit";
			//if (strItemDescr === SHOWITEM)
			//{
			//	console.log("___ ITEM '" + SHOWITEM + "': ___");
			//	console.log(">>> bMatchInItem = " + bMatchInItem);
			//	console.log(">>> bMatchInWhere = " + bMatchInWhere);
			//	console.log(">>> nMatchStart = " + nMatchStart);
			//	console.log(">>> nMatchEnd = " + nMatchEnd);
			//	console.log(">>> strLine = '" + strLine + "'");
			//	console.log(">>> item = '" + strLine.substring(nItemStart, nItemEnd) + "'");
			//	console.log(">>> where = '" + strLine.substr(nWhereStart) + "'");
			//	console.log(">>> strOverallMatch = '" + strOverallMatch + "'");
			//	console.log(match);
			//}
			
			let nPrevPartMatchEnd = nItemStart;
			let nPrevSkippedCharsEnd = nMatchStart;
			let nScore = 0;
			let nNumPartScores = 0;
			let strLineHilited = "";
			
			// Get score for for each matching part, then average those part scores to get the overall
			// score; match parts start at group 2, and there's a pair of groups captured for each part:
			// (1) the matching part, and (2) the subsequent skipped chars up to the next matching part
			const nNumGroups = match.length;
			for (let i = 2; i < nNumGroups; i += 2)
			{
				const strPartMatch = match[i];
				const nPartMatchStart = nPrevSkippedCharsEnd;
				const nPartMatchEnd = nPartMatchStart + strPartMatch.length;
				const bPartMatchInItem = (nPartMatchStart < nWhereStart);
				const bPartMatchInWhere = (nPartMatchEnd > nWhereStart);
				
				if (bPartMatchInWhere)
				{
					const nPrevWherePartMatchEnd = (i == 2)? nWhereStart : nPrevPartMatchEnd;
					nScore += getWherePartMatchScore(strPartMatch, strLine, nPartMatchStart, nPrevWherePartMatchEnd);
				}
				else
					nScore += getPartMatchScore(strPartMatch, strLine, nPartMatchStart, nPrevPartMatchEnd, nItemEnd);
				
				nNumPartScores++;
				
				if (bPartMatchInItem && bPartMatchInWhere)
					// This match part spans across the item/where record-separator, so
					// need to close and re-open the MatchText span around that separator
					strLineHilited += strLine.substring(nPrevPartMatchEnd, nPartMatchStart)
									+ '<span class="MatchText">'
									+ strLine.substring(nPartMatchStart, nItemEnd)
									+ '</span>'
									+ kStrRecordSeparator
									+ '<span class="MatchText">'
									+ strLine.substring(nWhereStart, nPartMatchEnd)
									+ '</span>';
				else
					strLineHilited += strLine.substring(nPrevPartMatchEnd, nPartMatchStart)
									+ '<span class="MatchText">'
									+ strLine.substring(nPartMatchStart, nPartMatchEnd)
									+ '</span>';
				
				nPrevPartMatchEnd = nPartMatchEnd;
				if ((i + 1) < nNumGroups)
					nPrevSkippedCharsEnd = nPartMatchEnd + match[i + 1].length;
			}
			
			strLineHilited += strLine.substr(nPrevPartMatchEnd);
			
			//if (strItemDescr === SHOWITEM)
			//{
			//	console.log(strLineHilited);
			//}
			
			// Score is average of the scores for the part matches
			nScore = nScore / nNumPartScores;
			
			const nQuantity = strQuantity? (parseInt(strQuantity) || 1) : 1;
			const nHilitedItemEnd = strLineHilited.indexOf(kStrRecordSeparator);
			const strItemDescr = strLineHilited.substr(0, nHilitedItemEnd);
			const strWhere = strLineHilited.substr(nHilitedItemEnd + kStrRecordSeparator.length);
			
			arrResults.push({nScore, bMatchInItem, bMatchInWhere, nQuantity, strItemDescr, strWhere, strItemInfo});
		}
	}
	
	arrResults.bMatchesInItem = bMatchesInItem;
	arrResults.bMatchesInWhere = bMatchesInWhere;
	return arrResults;
}


function styleWhere(strWhere)
{
	// Find "main where", the 2nd tab-delimited item in strWhere (e.g. the compartment number)
	const nFirstSepIndex = strWhere.indexOf(kStrInternalSeparator);
	if (nFirstSepIndex < 1)
		return strWhere;
	
	const nMainWhereStart = nFirstSepIndex + kStrInternalSeparator.length;
	var nSecondSepIndex = strWhere.indexOf(kStrInternalSeparator, nMainWhereStart);
	if (nSecondSepIndex == -1)
		nSecondSepIndex = strWhere.length;
	
	var strWhereHead = strWhere.substr(0, nFirstSepIndex);
	var strMainWhere = strWhere.substring(nMainWhereStart, nSecondSepIndex);
	var strWhereTail = strWhere.substr(nSecondSepIndex + kStrInternalSeparator.length);
	
	if (strMainWhere.lastIndexOf('<span class="MatchText">') > strMainWhere.lastIndexOf('</span>'))
	{
		// A "MatchText" span starts in the "main where" but finishes outside of it,
		// so need to close out that span and start a new one at start of next item
		strMainWhere += '</span>';
		strWhereTail = '<span class="MatchText">' + strWhereTail;
	}
	
	// Enclose the "main where" in a span of class "MainWhere"
	strWhere = strWhereHead + kStrInternalSeparator
				+ '<span class="MainWhere">' + strMainWhere + '</span>'
				+ kStrInternalSeparator + strWhereTail;
	
	
	//##### TODO: INCORPORATE IMAGE LINKS BASED ON gMapImages KEYED BY SUBSTRS OF strWhere
	//			- loop through kStrInternalSeparator's in strWhere
	//			  (maybe also integrate "MainWhere" behavior into this loop -- i.e. when nPartNum == 2)
			/*
			nWherePartStart = nWherePartEnd + 1;
			nWherePartEnd = strWhere.indexOf(kStrInternalSeparator, nWherePartStart);
			if (nWherePartEnd === -1) ...
			var strWherePart = strWhere.substring(nWherePartStart, nWherePartEnd);
			const strImageUrl = gMapImages[strWhere.substr(0, nWherePartEnd)];
			const bInMainWhere = (nPartNum === 2);
			if (strImageUrl || bInMainWhere)
			{
				if (strMainWhere.lastIndexOf('<span class="MatchText">') > strMainWhere.lastIndexOf('</span>'))
				{
					// A "MatchText" span starts in this where part but finishes outside of it,
					// so need to close out that span and start a new one at start of next part
					strWherePart += '</span>';
					strWhere = strWhere.substr(0, nWherePartEnd) + '<span class="MatchText">' + strWhere.substr(nWherePartEnd);
				}
				const strClass = (strImageUrl && bInMainWhere)? "PictureButton MainWhere" : strImageUrl? "PictureButton" : "MainWhere";
				var strAttribs = ` class="${strClass}"`;
				if (strImageUrl)
					strAttribs += ` data-url="${strImageUrl}"`;
				//...wrap this where-part in `<span ${strAttribs}>`...'</span>'
			}
			*/
	
	//#####
	//strWhere += '<img style="height: 0.85em; padding-left: 0.35em; margin-bottom: -0.025em;" src="PictureIcon.png" />'
	
	
	// And finally, replace all the internal separators with the UI separator text
	return strWhere.replaceAll(kStrInternalSeparator, kStrWhereSeparator);
}


// Higher match score for:
// 
// 1. Complete word match with given search word
// 	  (so "D4 E" scores "[D4] Sh[e]lf..." *below*
// 	  "[D4] Shelf 3 Box [E]")
// 
// 2. Search words closer to start of match words
// 	 	(significant score for at-start, much lower
// 	 	fractional score for anywhere else in match
// 	 	word, diminishing with distance from start)
// 
// 3. Also score for number of letters matching within
// 	 	surrounding word, proportional to fraction
// 	 	of number of letters in surrounding word --
// 	 	with special-case for only 1-letter match
// 	  (if surrounding word is more than 1 letter):
// 	  very low score (though higher at start of word)
// 
// 4. First search word closer to start of target
// 
// 5. Shorter distance between search words in match
//
function getPartMatchScore(strMatch, strText, nMatchStart, nPrevPartMatchEnd, nItemEnd)
{
	// Find match's word offset from previous match part, and char offset within word
	var nPrevSpacePos = nMatchStart - 1;
	var nWordIndex = 0;
	for (var i = nPrevPartMatchEnd; i < nMatchStart; i++)
	{
		if (strText[i] == " ")
		{
			nWordIndex++;
			nPrevSpacePos = i;
		}
	}
	const nLetterIndex = nMatchStart - nPrevSpacePos - 1;
	
	var nScore;
	if (nLetterIndex == 0)
	{
		// Match is at start of a word
		nScore = 1000 - nWordIndex*100;
	}
	else
	{
		// Match is elsewhere within a word
		var nOffsetInWord = nMatchStart - nPrevSpacePos;
		nScore = 500 - nWordIndex*50 - nOffsetInWord;
	}
	
	// Reduce score overall based on distance from previous part's match, ignoring word break
	if (!/[A-Za-z0-9]/.test(strText.charAt(nPrevPartMatchEnd)))
		nPrevPartMatchEnd++;
	nScore -= nMatchStart - nPrevPartMatchEnd;
	
	// Reduce score by number of letters after match within word
	var nMatchEnd = nMatchStart + strMatch.length;
	var nMatchWordEndPos = strText.indexOf(" ", nMatchEnd);
	if (nMatchWordEndPos == -1)
		nMatchWordEndPos = strText.length;
	nScore -= (nMatchWordEndPos - nMatchEnd);
	
	// Reduce score by number of letters after match
	if (nMatchEnd > nItemEnd)
		nItemEnd = strText.length;
	nScore -= (nItemEnd - nMatchEnd);
	
	return nScore;
}


function getWherePartMatchScore(strMatch, strText, nMatchStart, nPrevPartMatchEnd)
{
	// Find match's section offset from previous match part, and word offset within its section
	var nPrevSpacePos = nMatchStart - 1;
	var nSectionIndex = 0;
	var nWordIndex = 0;
	for (var i = nPrevPartMatchEnd; i < nMatchStart; i++)
	{
		if (strText[i] == "\t")
		{
			nSectionIndex++;
			nWordIndex = 0;
			nPrevSpacePos = i;
		}
		else if (strText[i] == " ")
		{
			nWordIndex++;
			nPrevSpacePos = i;
		}
	}
	// Get distance from start of word, i.e. offset from start of containing word to start of match
	const nOffsetInWord = nMatchStart - nPrevSpacePos - 1;
	
	// Get distance from end of word, i.e. offset from end of match to end of containing word
	const nMatchEnd = nMatchStart + strMatch.length;
	const nSpacePos = strText.indexOf(" ", nMatchEnd);
	const nTabPos = strText.indexOf("\t", nMatchEnd);
	const nMatchWordEndPos = Math.min(((nSpacePos !== -1)? nSpacePos : strText.length),
										((nTabPos !== -1)? nTabPos : strText.length));
	const nOffsetFromEndOfWord = nMatchWordEndPos - nMatchEnd;
	
	// A match that is a whole tab-delimited section gets a higher score, reduced minimally by section number
	if (nOffsetInWord === 0 && (strText[nPrevSpacePos] === "\t" || strText[nPrevSpacePos] === kStrRecordSeparator)
		&& nOffsetFromEndOfWord === 0 && (nMatchWordEndPos === strText.length || strText[nMatchWordEndPos] === "\t"))
		return 1000 - nSectionIndex*5;
	
	var nScore;
	if (nOffsetInWord === 0)
	{
		// Match is at start of a word
		nScore = 1000 - nSectionIndex*100 - nWordIndex*10;
	}
	else
	{
		// Match is elsewhere within a word
		nScore = 500 - (nSectionIndex + nWordIndex)*50 - nOffsetInWord;
	}
	
	// Reduce score if it's just a single-letter match that's not the whole word
	if (strMatch.length === 1 && (nOffsetInWord !== 0 || nOffsetFromEndOfWord !== 0))
		nScore /= 2;
	
	// Reduce score overall based on distance from previous part's match, ignoring word break
	if (!/[A-Za-z0-9]/.test(strText[nPrevPartMatchEnd]))
		nPrevPartMatchEnd++;
	nScore -= nMatchStart - nPrevPartMatchEnd;
	
	// Reduce score by number of letters after match within word
	nScore -= (nMatchWordEndPos - nMatchEnd);
	
	// Reduce score by number of letters after match
	nScore -= (strText.length - nMatchEnd);
	
	return nScore;
}


// NOTE: this must match server-side implementation exactly
//
const INVENTORY_JSON_DELIM = '\n"""""\n';  // since more than 2 consecutive double-quotes can't appear in valid JSON
function parseCombinedInventoryText(str)
{
  const jsonEnd = str.indexOf(INVENTORY_JSON_DELIM);
  const inventoryStart = jsonEnd + INVENTORY_JSON_DELIM.length;
  const hasDelimiter = (jsonEnd !== -1);

  var clientConfig = safeJsonParse(hasDelimiter? str.substring(0, jsonEnd) : str);
	if (!clientConfig || !hasDelimiter)
		return clientConfig;
	
  const rigInventoriesMap = clientConfig.rigInventoriesMap;
  for (const rigName in rigInventoriesMap)
  {
    const textOffsets = rigInventoriesMap[rigName];
    rigInventoriesMap[rigName] = str.substring(inventoryStart + textOffsets.fromOffset, inventoryStart + textOffsets.toOffset);
  }

  return clientConfig;
}


function safeJsonParse(str)
{
  try
  {
    return JSON.parse(str);
  }
  catch (e)
  {
    return undefined;
  }
}


function clearCache()
{
	gObjInventoryInfo = null;
	localStorage.removeItem(INVENTORYCACHE_STORAGE_KEY);
	localStorage.removeItem(LOCATIONPICSMAP_STORAGE_KEY);
	
	// Empty the search text
	searchText_saveValueAndRefresh("");
	
	// Finally, reload the page to reset everything and update the set of rig toggles if needed
	window.location.reload(true);
}


function searchInput_onSubmit()
{
	// Hidden "clear cache" command
	var eltSearchInput = document.getElementById("SearchInput");
	if (eltSearchInput.value.trim().toLowerCase() === "clear cache")
		clearCache();
	
	// Special case for iOS Safari: extra unfocus actions in order to make iOS keyboard dismiss
	document.activeElement.blur();
	eltSearchInput.blur();
	window.focus();
	
	window.event.preventDefault();
	return false;
}



function searchInput_onKeyUp(eltSearchInput, evt)
{
	searchText_saveValueAndRefresh(eltSearchInput.value);
}


function searchText_saveValueAndRefresh(strVal)
{
	strVal = strVal.trim();
	if (strVal === gStrSearchText)
		return;
	
	gStrSearchText = strVal;
	localStorage.setItem(SEARCHTEXT_STORAGE_KEY, strVal);
	updateSearchResults();
}


function itemDescr_onClick(evt)
{
	if (gEltLinksMenuShownFor === evt.target)
		dismissLinksMenu();
	else
		openLinksMenu(evt.target);
}


function openLinksMenu(eltItemDescr)
{
	dismissLinksMenu();
	
	const strLinks = eltItemDescr?.getAttribute("data-links");
	if (!strLinks)
		return;
	
	const arrLinks = safeJsonParse(strLinks);
	if (!arrLinks)
		return;
	
	// Determine scroll offset
	let elt = eltItemDescr;
	let scrollX = 0;
	let scrollY = 0;
	while (elt)
	{
		scrollX += elt.scrollLeft;
		scrollY += elt.scrollTop;
		elt = elt.parentElement;
	}
	
	// Position menu below eltItemDescr
	const boundingRect = eltItemDescr.getBoundingClientRect();
	const menuLeft = boundingRect.left + scrollX + REM_PX;
	const menuTop = boundingRect.bottom + scrollY + REM_PX / 4;
	const eltLinksMenu = document.getElementById("ItemLinksMenu");
	eltLinksMenu.style.left = `${menuLeft}px`;
	eltLinksMenu.style.top = `${menuTop}px`;
	
	// Clear out old menu items
	while (eltLinksMenu.firstChild)
		eltLinksMenu.removeChild(eltLinksMenu.lastChild);
	
	// Build new menu items
	for (const {title, icon, url} of arrLinks)
	{
		const eltMenuItem = document.createElement("A");
		const eltIcon = document.createElement("IMG");
		eltIcon.src = `LinkIcon_${icon}.png`;
		eltMenuItem.appendChild(eltIcon);
		eltMenuItem.appendChild(document.createTextNode(title));
		eltMenuItem.href = url;
		eltMenuItem.target = "_blank";
		eltLinksMenu.appendChild(eltMenuItem);
	}
	
	gEltLinksMenuShownFor = eltItemDescr;
	fadeElt(eltLinksMenu, 0.15, true);
}


function dismissLinksMenu()
{
 	if (gEltLinksMenuShownFor)
	{
		document.getElementById("ItemLinksMenu").style.display = "none";
		gEltLinksMenuShownFor = null;
	}
}


function maybeDismissLinksMenu(evt)
{
	if (gEltLinksMenuShownFor
			&& !gEltLinksMenuShownFor.contains(evt.target)
			&& !document.getElementById("ItemLinksMenu").contains(evt.target))
		dismissLinksMenu();
}


function rigSelect_onMouseDown(evt)
{
	const coords = getEventCoords(evt);
	if (!coords)
		return;
	
	const [x, y] = coords;
	const eltRigCheckbox = getRigSelectAtCoords(x, y);
	if (!eltRigCheckbox)
		return;
	
	evt.preventDefault();
	
	const bChecked = !eltRigCheckbox.checked;
	eltRigCheckbox.checked = bChecked;
	
	const checkedStates = {};
	document.querySelectorAll("#RigToggles input[type=checkbox]")
		.forEach(elt => checkedStates[elt.name] = elt.checked);

	// Allow drag-selection up to a 1rem slop around the toggles
	const slop = REM_PX;
	const boundingRect = document.getElementById("RigToggles").getBoundingClientRect();

	gObjRigSelectMouseDown.elt = eltRigCheckbox;
	gObjRigSelectMouseDown.bChecked = bChecked;
	gObjRigSelectMouseDown.initialChecks = checkedStates;
	gObjRigSelectMouseDown.startX = x;
	gObjRigSelectMouseDown.startY = y;
	gObjRigSelectMouseDown.eltHiliteBox = document.getElementById("RigSelectionHilite");
	gObjRigSelectMouseDown.dragLimitLeft = boundingRect.left - slop;
	gObjRigSelectMouseDown.dragLimitTop = boundingRect.top - slop;
	gObjRigSelectMouseDown.dragLimitRight = boundingRect.left + Math.abs(boundingRect.width) + slop;
	gObjRigSelectMouseDown.dragLimitBottom = boundingRect.top + Math.abs(boundingRect.height) + slop;
	
	onSelectedRigsChanged();
}


function rigSelect_onMouseOver(evt)
{
	// If not in a click-and-drag/touch-and-drag that started on a rigSelect button, then keep default behavior
	if (!gObjRigSelectMouseDown.elt)
		return;
	
	evt.preventDefault();
		
	const coords = getEventCoords(evt);
	if (!coords)
		return;
	
	let [x, y] = coords;
	const {startX, startY, bChecked, initialChecks, eltHiliteBox,
					dragLimitLeft, dragLimitTop, dragLimitRight, dragLimitBottom} = gObjRigSelectMouseDown;
	
	let bShowHilite = true;
	if (x < dragLimitLeft || x >= dragLimitRight || y < dragLimitTop || y >= dragLimitBottom)
	{
		// Suppress the selection hilite if dragged outside the limits
		bShowHilite = false;
		x = startX;
		y = startY;
	}
	
	const hiliteLeft = Math.min(x, startX);
	const hiliteTop = Math.min(y, startY);
	const hiliteWidth = Math.max(Math.abs(x - startX), 4);   // don't let width be under 4px
	const hiliteHeight = Math.max(Math.abs(y - startY), 4);  // don't let height be under 4px
	const hiliteRight = hiliteLeft + hiliteWidth;
	const hiliteBottom = hiliteTop + hiliteHeight;
	
	const hiliteStyle = eltHiliteBox.style;
	hiliteStyle.display = bShowHilite? "inline-block" : "none";
	hiliteStyle.left = `${hiliteLeft}px`;
	hiliteStyle.top = `${hiliteTop}px`;
	hiliteStyle.width = `${hiliteWidth}px`;
	hiliteStyle.height = `${hiliteHeight}px`;
	
	// Determine which toggles the hilite overlaps
	document.querySelectorAll("#RigToggles > label").forEach(eltLabel =>
	{
		const eltRigToggle = eltLabel.firstElementChild;
		const labelRect = eltLabel.getBoundingClientRect();
		const bHiliteOverlaps = (labelRect.right >= hiliteLeft && labelRect.left <= hiliteRight
															&& labelRect.top <= hiliteBottom && labelRect.bottom >= hiliteTop);
		
		// If it overlaps this toggle, set checked to same as the initially clicked toggle's state;
		// if not, revert it to its own initial toggle state
		eltRigToggle.checked = bHiliteOverlaps? bChecked : eltRigToggle.checked = initialChecks[eltRigToggle.name];
	});
	
	onSelectedRigsChanged();
}


function rigSelect_onMouseUp(evt)
{
	if (gObjRigSelectMouseDown.elt)
	{
		gObjRigSelectMouseDown.elt = null;
		gObjRigSelectMouseDown.eltHiliteBox.style.display = "none";
		evt.preventDefault();
	}
}


function getEventCoords(evt)
{
	let x = evt.clientX;
	let y = evt.clientY;
	if (x !== undefined && y !== undefined)
		return [x, y];

	if (evt.touches?.length === 1)
	{
		x = evt.touches[0]?.clientX;
		y = evt.touches[0]?.clientY;
		if (x !== undefined && y !== undefined)
			return [x, y];
	}

	return null;
}


function getRigSelectAtCoords(x, y)
{	
	let eltRigCheckbox = null;
	const eltActualTarget = document.elementFromPoint(x, y);
	if (!eltActualTarget)
		return null;
	
	if (eltActualTarget.tagName === "INPUT")
		eltRigCheckbox = eltActualTarget;
	else if (eltActualTarget.tagName === "SPAN")
		eltRigCheckbox = eltActualTarget.previousElementSibling;
	else if (eltActualTarget.tagName === "LABEL")
		eltRigCheckbox = eltActualTarget.firstElementChild;
	
	if (eltRigCheckbox?.tagName === "INPUT" && eltRigCheckbox.parentElement?.parentElement?.id === "RigToggles")
		return eltRigCheckbox;
	else
		return null;
}


function onSelectedRigsChanged()
{
	const arrCheckedButtonNames = Object.values(gMapRigCheckboxes).filter(elt => elt.checked).map(elt => elt.name);
	if (arrayEquals(arrCheckedButtonNames, gArrCheckedButtonNames))
		return;
	
	localStorage.setItem(SELECTEDRIGS_STORAGE_KEY, JSON.stringify(arrCheckedButtonNames));
	
	const bNewRigSelected = arrCheckedButtonNames.some(name => !gArrCheckedButtonNames.includes(name));
	gArrCheckedButtonNames = arrCheckedButtonNames;
	
	if (bNewRigSelected)
		fetchUpdateIfNeeded();
	
	updateUIMode();
	updateSearchResults();
}


function showUpdateUI(nMillisecs)
{
	gbPendingUpdateUI = true;
	updateUIMode();
	setTimeout(() => {
		if (!gbPendingUpdateFetch)
		{
			gbPendingUpdateUI = false;
			updateUIMode();
		}
	}, nMillisecs);
}


function updateUIMode()
{
	// Show or hide status message, depending on whether any rigs are selected or not
	const bNoRigsSelected = !Object.values(gMapRigCheckboxes).some(eltInput => eltInput.checked);
	document.getElementById("StatusMessage").style.display = bNoRigsSelected? "block" : "none";
	
	// Show or hide "loading" modal, depending on whether any content requests are pending
	showHideModal("LoadingModal", gbPendingUpdateUI);
}


function showServerError(strErrorMsg)
{
	// Special-case to make it more intelligible
	if (strErrorMsg.endsWith(" fetch"))
		strErrorMsg += " from server";
	
	console.warn(`SERVER ERROR:  ${strErrorMsg}`);
	
	// Set message box content
	document.getElementById("ErrorMessage").innerText = strErrorMsg;
	
	// If don't have local cache and not in the process of fetching it, then UI is in
	// unusable state, so skip the error indicator and go directly to the message box
	if (!gObjInventoryInfo && !gbPendingUpdateFetch && !gbPendingDelayedUpdateFetch)
	{
		showHideErrorMessageBox(true);
		return;
	}
	
	// Show error indicator
	const eltErrIndicator = document.getElementById("ErrorIndicator");
	fadeElt(eltErrIndicator, 0.2, true);
	
	// Automatically dismiss error indicator after 10 seconds (if not already dismissed by click)
	setTimeout(() => fadeElt(eltErrIndicator, 1, false), 10000);
}


function showHideErrorMessageBox(bShow)
{
	// Dismiss error indicator when show message box
	if (bShow)
		fadeElt(document.getElementById("ErrorIndicator"), 0.15, false);
	
	showHideModal("ErrorMessageModal", bShow);
}


function showHideModal(strModalID, bShow)
{
	const nDurationSeconds = bShow? 0.15 : 0.1;
	fadeElt(document.getElementById(strModalID), nDurationSeconds, bShow);
}


function fadeElt(elt, nDurationSeconds, bFadeIn)
{
	const nToOpacity = bFadeIn? 1 : 0;
	const eltStyle = elt.style;
	
	eltStyle.transition = `opacity ${nDurationSeconds}s`;
	if (!isNumber(eltStyle.opacity))
		eltStyle.opacity = bFadeIn? 0 : 1;
	
	// Wait a moment before setting target opacity, otherwise the transition animation won't trigger
	setTimeout(() => { eltStyle.opacity = nToOpacity; }, 1);
	
	// If fading in, show elt at start of fade animation; if fading-out, hide elt at end of fade animation
	if (bFadeIn)
		eltStyle.display = "block";
	else
		setTimeout(() => { eltStyle.display = "none"; }, Math.round(nDurationSeconds * 1000));
}


function isNumber(val)
{
	switch (typeof val)
	{
		case "number":
			return true;
		case "string":
			return val !== "" && !isNaN(val);  // isNaN coerces arg to num if possible, treats as NaN if coercion fails
		default:
			return false;
	}
}

