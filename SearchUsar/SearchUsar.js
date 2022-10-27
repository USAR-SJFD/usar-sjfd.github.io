
// Global consts
const kArrInitialRigs = ["A", "B"];
const kstrServerUrl = "https://script.google.com/macros/s/AKfycbzxmxu01VBtHNwufDAty4fgYLFLigvaTn7_Gcs9ctcxRiiOjsSvzhEQp2f9upEVg0OE/exec?rig=";
const kstrGetImagesMapParam = "&getImagesMap=1";
const kstrGetRigListUrlParam = "&getRigList=1";
const kstrGetModTimeUrlParam = "&getModTime=1";
const kCacheRigSuffix = "_riginfo";
const knMinimumSearchTextLen = 2;
const kStrInternalSeparator = "\t";

const kStrRecordSeparator = "␞";           // 'record separator' (unicode 9246)
const kStrWhereSeparator = " ≫ ";          // 'much greater-than' (unicode 8811)
//const kStrWhereSeparator = " ▻ ";
//const kStrWhereSeparator = " ➤ ";
//const kStrWhereSeparator = " ⨠ ";
//const kStrWhereSeparator = "&thinsp;➝ ";
//const kStrWhereSeparator = "&thinsp;➛ ";


// Global vars
var gMapImages = {};
var gMapRigToggles = {};
var gMapRigContents = {};
var gMapPendingContentRequests = {};
var gStrSearchText = "";
var gStrLastJson = "";



function init()
{
	if (localStorage.getItem("serverVersion") !== kstrServerUrl)
	{
		localStorage.setItem("serverVersion", kstrServerUrl);
		console.log("Clearing local cache because server version has been updated");
		clearCache();
	}
	
	setupRigToggles();
	sendRequest("", kstrGetRigListUrlParam, response_updateRigList);
	
	loadImagesMap();
	
	const strSearchText = localStorage.getItem("searchText");
	if (strSearchText)
	{
		const eltSearchInput = document.getElementById("SearchInput");
		eltSearchInput.value = strSearchText;
		searchText_saveValueAndRefresh(strSearchText);
	}
	
	// Header is floating fixed, so pad the rest of the content (Calls) down to just below header
	var nPageHeaderHeight = document.getElementById("PageHeader").offsetHeight;
	document.getElementById("HeadingSpacer").style.height = nPageHeaderHeight + "px";
	document.getElementById("ModalOverlay").style.top = nPageHeaderHeight + "px";
	var nOverlayHeight = document.getElementById("ModalOverlay").offsetHeight - nPageHeaderHeight;
	document.getElementById("AwaitResultsModal").style.height = nOverlayHeight + "px";
	
	updateUIMode();
	updateSearchResults();
}


function loadImagesMap()
{
	console.log("Loading images-map from local cache; asynchronously checking server for updates...");
	const strImagesMapJSON = localStorage.getItem("imagesMap");
	gMapImages = strImagesMapJSON? JSON.parse(strImagesMapJSON) : {};
	sendRequest("", kstrGetImagesMapParam + kstrGetModTimeUrlParam, response_refetchImagesMapIfNeeded);
}


function response_refetchImagesMapIfNeeded()
{
	const objResponse = this;
	var strRemoteModTime = objResponse.responseText;
	if (!gMapImages.modTime || (strRemoteModTime && (strRemoteModTime !== gMapImages.modTime)))
	{
		console.log("--> Newer images-map on server; clearing local cache & refetching");
		// Remove from cache
		localStorage.removeItem("imagesMap");
		// And re-fetch
		sendRequest("", kstrGetImagesMapParam, response_updateImagesMap);
	}
	else
		console.log("--> Local cache for images-map is up to date with server");
}


function response_updateImagesMap()
{
	const objResponse = this;
	var strImagesMapJSON = objResponse.responseText;
	var mapImages = JSON.parse(strImagesMapJSON);
	if (mapImages)
	{
		console.log("--> Images-map received");
		gMapImages = mapImages;
		localStorage.setItem("imagesMap", strImagesMapJSON);
		updateSearchResults();
	}
}


function response_updateRigList()
{
	const objResponse = this;
	var strRigListJSON = objResponse.responseText;
	var arrRigList = JSON.parse(strRigListJSON);
	if (arrRigList && arrRigList.length > 0)
	{
		localStorage.setItem("rigList", strRigListJSON);
		setupRigToggles();
	}
}


function setupRigToggles()
{
	const strRigListJSON = localStorage.getItem("rigList");
	const strEnabledRigsJSON = localStorage.getItem("enabledRigs");
	const arrRigList = strRigListJSON? JSON.parse(strRigListJSON) : kArrInitialRigs;
	const arrEnabledRigs = strEnabledRigsJSON? JSON.parse(strEnabledRigsJSON) : [];
	const eltRigTogglesDiv = document.getElementById("RigToggles");
	
	// Remove all current rig toggles
	gMapRigToggles = {};
	while (eltRigTogglesDiv.firstChild)
		eltRigTogglesDiv.removeChild(eltRigTogglesDiv.lastChild);
    
	// Create the specified rig toggles in alphabetical order
	arrRigList.sort();
	console.log(`Rigs: ${arrRigList}; enabled: ${arrEnabledRigs}`);
	for (const i in arrRigList)
	{
		// Ensure only one toggle per rig (in case of erroneous backend data)
		const strRigLetter = arrRigList[i];
		if (strRigLetter in gMapRigToggles)
			continue;
		
		// Build this element structure for each toggle:
		//   <label>
		//      <input type="checkbox" name="A" onclick="rigSelect_onClick(this)" />
		//      <span> A </span>
		//	 </label>
		const eltLabel = document.createElement("label");
		const eltInput = document.createElement("input");
		const eltSpan = document.createElement("span");
		eltInput.setAttribute("type", "checkbox");
		eltInput.setAttribute("name", strRigLetter);
		eltInput.setAttribute("onclick", "rigSelect_onClick(this)");
		eltSpan.appendChild(document.createTextNode(strRigLetter));
		eltLabel.appendChild(eltInput);
		eltLabel.appendChild(eltSpan);
		eltRigTogglesDiv.appendChild(eltLabel);
		gMapRigToggles[strRigLetter] = eltInput;
		if (arrEnabledRigs.includes(strRigLetter))
		{
			eltInput.checked = true;
			loadRig(strRigLetter);
		}
	}
}


function updateSearchResults()
{
	const arrEnabledRigs = Object.keys(gMapRigContents);
	const bNoRigsSelected = (arrEnabledRigs.length == 0);
	
	if (bNoRigsSelected || gStrSearchText.length < knMinimumSearchTextLen)
		return rebuildSearchResultsTable([]);
	
	const strDistilledLowerSearchText = distillSearchText(gStrSearchText);
	if (!strDistilledLowerSearchText)
		return rebuildSearchResultsTable([]);
	
	// Primary regex is case-[i]nsensitive, [m]ulti-line (to treat each line as separate match-target), 
	// and [g]lobal (to find all matching lines, not just the first)
	const searchRegex = buildSearchRegex(strDistilledLowerSearchText, "img");
	const searchWhereRegex = buildSearchRegex(strDistilledLowerSearchText, "i", true);
	
	console.log(searchRegex);
	console.log(searchWhereRegex);
	
	// Combine search results for all selected rigs -- in alphabetical rig order,
	// so same-score results will be in that order after final sort
	arrEnabledRigs.sort();
	var arrResults = [];
	var bMatchesInItem = false;
	var bMatchesInWhere = false;
	for (const i in arrEnabledRigs)
	{
		const strRigLetter = arrEnabledRigs[i];
		//arrResults = arrResults.concat(searchRigContents(strRigLetter, strSearchTextLower));
		const arrRigResults = searchRigContents(strRigLetter, searchRegex, searchWhereRegex);
		arrResults = arrResults.concat(arrRigResults);
		bMatchesInItem ||= arrRigResults.bMatchesInItem;
		bMatchesInWhere ||= arrRigResults.bMatchesInWhere;
	}
	console.log(`IN ITEMS?  ${bMatchesInItem}   IN WHERES?  ${bMatchesInWhere}`);
	
	// Sort results from highest to lowest score
	arrResults.sort((match1, match2) => (match2.nScore - match1.nScore));
	
	// Split results in those that matched only in the "where" section, and all others
	var arrResultsInWhere = arrResults.filter(match => (match.bMatchInWhere && !match.bMatchInItem));
	var arrResultsOther = arrResults.filter(match => !(match.bMatchInWhere && !match.bMatchInItem));
	
	const nNumResultsInWhere = arrResultsInWhere.length;
	const nNumResultsOther = arrResultsOther.length;
	
	var nScoreInWhere = 0; for (const match of arrResultsInWhere) nScoreInWhere += match.nScore;
	var nScoreOther = 0; for (const match of arrResultsOther) nScoreOther += match.nScore;
	
	const nAvgScoreInWhere = nNumResultsInWhere && (nScoreInWhere / nNumResultsInWhere);
	const nAvgScoreOther = nNumResultsOther && (nScoreOther / nNumResultsOther);
	
	console.log(`NUM IN WHERE: ${nNumResultsInWhere}   AVG SCORE: ${nAvgScoreInWhere}`)
	console.log(`   NUM OTHER: ${nNumResultsOther}   AVG SCORE: ${nAvgScoreOther}`)
	
	rebuildSearchResultsTable(arrResults);
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
		const {nScore, nQuantity, strItemDescr, strWhere} = arrResults[i];
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
		
		// FOR TESTING
		//if (strItemDescr) strItemDescr = `(${nScore})  ${strItemDescr}`;
		
		const eltItemDescr = document.createElement("span");
		eltItemDescr.className = "ItemDescr";
		if (!bSameAsPrevItem)
			eltItemDescr.innerHTML = strItemDescr;
		
		const eltItemQuantity = document.createElement("span");
		eltItemQuantity.className = "Quantity";
		eltItemQuantity.setAttribute("data-quantity", nQuantity);
		
		const eltTD1 = document.createElement("td");
		if (bSameAsPrevItem)
			eltTD1.className = "NoLine";
		eltTD1.appendChild(eltItemDescr);
		eltTD1.appendChild(eltItemQuantity);
		
		const eltTD2 = document.createElement("td");
		eltTD2.className = "ItemWhere";
		if (bSameAsPrevWhere)
			eltTD2.className = "NoLine";
		else
			eltTD2.innerHTML = styleWhere(strWhere);
		
		const eltTR = document.createElement("tr");
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
	var strSearchPattern = strDistilledLowerSearchText;
	if (bForWhereSection)
	{
		// For searching the "where" section, special case for (box|shelf|section|unit) followed by
		// a number or single letter after a space: treat that space like it's in a quoted section
		// and require the phrase to match only on word boundaries
		var strWhereSearchPattern =
			strSearchPattern.replace(/\b(box|shelf|section|unit) (\d+|[a-z])\b/g, "\\b$1_$2\\b");
		
		// Similar special case for the phrase "[letter] (rig|hauler|trailer)"
		strWhereSearchPattern =
			strWhereSearchPattern.replace(/(?<!\\)\b([a-z])[ \-](rig|hauler|trailer)\b/g, "\\b$1_$2\\b");
		
		// And finally, special case for single letter on its own: require it to match only on word boundaries
		strWhereSearchPattern =
			strWhereSearchPattern.replace(/(?<!\\)\b([a-z])\b(?!_)/g, "\\b$1\\b");
		
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
	
	// Special case to allow abbreviated search for "Shelf/Section"
	strSearchPattern = strSearchPattern.replace(/\bshelf\b(?![^a-z0-9]+section\b)/g, "shelf(?:/section)?");
	
	//// Remove any single-letter words that aren't within a quoted section or next to a hyphen
	//strSearchPattern = strSearchPattern.replace(/(?:^| )[a-z](?: |$)/g, "");
	
	// Any other space matches any non-empty string -- i.e. replace each remaining space with pattern .+?
	// and enclose preceding & following chars in group parens, plus enclose skipped chars in group parens
	strSearchPattern = strSearchPattern.replaceAll(" ", ")(.+?)(");
	
	// Finally, skip over initial 'record' (rig & quantity info), and add initial and final group parentheses
	strSearchPattern = `^([^${kStrRecordSeparator}]*${kStrRecordSeparator}.*?)(${strSearchPattern})`;
	
	return new RegExp(strSearchPattern, strRegexFlags);
}


function searchRigContents(strRigLetter, searchRegex, searchWhereRegex)
{
	const objRigInfo = gMapRigContents[strRigLetter];
	const strRigContents = objRigInfo?.contents;
	if (!strRigContents?.length)
		return [];	// should only be possible if backend error
	
	//const displayName = objRigInfo.displayName;
	//const bIsSubRig = (typeof displayName !== "string");
	
	var bMatchesInItem = false;
	var bMatchesInWhere = false;
	var arrResults = [];
	
	searchRegex.lastIndex = 0;
	var nLineEnd = -1;
	var match;
	while ((match = searchRegex.exec(strRigContents)) !== null)
	{
		var strOverallMatch = match[0];
		var nMatchStart = match.index;  // note this is always start of line, since regex begins with '^'
		var nMatchEnd = nMatchStart + strOverallMatch.length;
		
		nLineStart = nMatchStart;
		var nLineEnd = strRigContents.indexOf("\n", nMatchEnd);
		if (nLineEnd === -1)
			nLineEnd = strRigContents.length;
		
		// Extract the line being matched
		const strLine = strRigContents.substring(nLineStart, nLineEnd);
		// Then make nMatchStart point to first match part relative to line -- i.e. skip
		// over first group, which contains all the chars before the first match part
		nMatchStart = match[1].length;
		// And also adjust nMatchEnd relative to line
		nMatchEnd -= nLineStart;
		
		const nRigAndQuantityEnd = strLine.indexOf(kStrRecordSeparator);
		const nItemStart = nRigAndQuantityEnd + kStrRecordSeparator.length;
		const nItemEnd = strLine.indexOf(kStrRecordSeparator, nItemStart);
		const nWhereStart = nItemEnd + kStrRecordSeparator.length;
		const bMatchInItem = nMatchStart < nWhereStart;
		const bMatchInWhere = nMatchEnd >= nWhereStart;
		bMatchesInItem ||= bMatchInItem;
		bMatchesInWhere ||= bMatchInWhere;
		
		//const strRigAndQuantity = strLine.substr(0, nRigAndQuantityEnd);
		//const nRigEnd = strRigAndQuantity.indexOf(kStrInternalSeparator);
		//const strSubRigAbbrev = (nRigEnd !== -1)? strRigAndQuantity.substr(0, nRigEnd) : strRigAndQuantity;
		//const strQuantity = (nRigEnd !== -1)? strRigAndQuantity.substr(nRigEnd + 1) : null;
		const strQuantity = strLine.substr(0, nRigAndQuantityEnd);
		
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
		
		var nPrevPartMatchEnd = nItemStart;
		var nPrevSkippedCharsEnd = nMatchStart;
		var nScore = 0;
		var nNumPartScores = 0;
		var strLineHilited = "";
		
		// Match parts start at group 2, and there's a pair of groups captured for each part:
		// (1) the matching part, and (2) the subsequent skipped chars up to the next matching part
		const nNumGroups = match.length;
		for (var i = 2; i < nNumGroups; i += 2)
		{
			const strPartMatch = match[i];
			const nPartMatchStart = nPrevSkippedCharsEnd;
			const nPartMatchEnd = nPartMatchStart + strPartMatch.length;
			const bPartMatchInItem = (nPartMatchStart < nWhereStart);
			const bPartMatchInWhere = (nPartMatchEnd > nWhereStart);
			
			//##################
			if (bPartMatchInWhere)
			{
				const nPrevWherePartMatchEnd = (i == 2)? nWhereStart : nPrevPartMatchEnd;
				nScore += getWherePartMatchScore(strPartMatch, strLine, nPartMatchStart, nPrevWherePartMatchEnd);
			}
			else
				nScore += getPartMatchScore(strPartMatch, strLine, nPartMatchStart, nPrevPartMatchEnd);
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
		
		arrResults.push({nScore, bMatchInItem, bMatchInWhere, nQuantity, strItemDescr, strWhere});
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
				const strClass = (strImageUrl && bInMainWhere)? "ImageButton MainWhere" : strImageUrl? "ImageButton" : "MainWhere";
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


function getPartMatchScore(strMatch, strText, nMatchStart, nPrevPartMatchEnd)
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
	nScore -= (strText.length - nMatchEnd);
	
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


function sendRequest(strRigLetter, strAdditionalParam, fcnOnResponse)
{
	const strUrl = kstrServerUrl + encodeURIComponent(strRigLetter) + (strAdditionalParam || "");
	const objReq = new XMLHttpRequest();
	objReq.addEventListener("load", fcnOnResponse);
	objReq.open("GET", strUrl);
	objReq.setRequestHeader("Content-Type", "text/plain;charset=utf-8");  // to avoid Google Apps Script CORS restriction
	objReq.send();
	objReq.strRigLetter = strRigLetter;  // remember which rig, in case response fails to include it
	return objReq;
}


function loadRig(strRigLetter)
{
	const strCachedRigInfoJSON = localStorage.getItem(strRigLetter + kCacheRigSuffix);
	objRigInfo = strCachedRigInfoJSON && JSON.parse(strCachedRigInfoJSON);
	if (strCachedRigInfoJSON)
	{
		// In cache
		console.log(`Loading ${strRigLetter} rig content from local cache; asynchronously checking server for updates...`);
		const objRigInfo = strCachedRigInfoJSON && JSON.parse(strCachedRigInfoJSON);
		gMapRigContents[strRigLetter] = objRigInfo;
		updateUIMode();
		updateSearchResults();
		
		// Request this rig file's modTime, then refetch/recache if it's newer than our cache
		sendRequest(strRigLetter, kstrGetModTimeUrlParam, response_refetchRigIfNeeded);
	}
	else if (!gMapPendingContentRequests[strRigLetter])
	{
		// Not in cache & there's not already a request pending for this rig
		console.log(`Requesting ${strRigLetter} rig content from server...`);
		const objReq = sendRequest(strRigLetter, null, response_storeReceivedRigContent);
		gMapPendingContentRequests[strRigLetter] = objReq;
		updateUIMode();
	}
	else
		console.log(`Already requesting ${strRigLetter} rig content from server...`);
}


// Called when rig has been "unselected"
function removeRig(strRigLetter)
{
	console.log(`Purging rig contents for ${strRigLetter} rig`);
	// Remove pending request for this rig's contents, if any
	unpendRigRequest(strRigLetter);
	delete gMapRigContents[strRigLetter];
	updateUIMode();
	updateSearchResults();
}


function unpendRigRequest(strRigLetter)
{
	// Was a request for this rig's contents pending?
	const objRemoveReq = gMapPendingContentRequests[strRigLetter];
	if (objRemoveReq)
	{
		// Yes; remove it from the pending requests map
		delete gMapPendingContentRequests[strRigLetter];
		// And abort it if still open
		if (objRemoveReq.status == 0)
			objRemoveReq.abort();
		
		const nNumPending = Object.keys(gMapPendingContentRequests).length;
		if (nNumPending)
			console.log(`...${nNumPending} rig contents request(s) still pending`);
		else
			console.log(`--> All rig contents requests completed`);
	}
}


function response_refetchRigIfNeeded()
{
	const objResponse = this;
	var objModTimeInfo = JSON.parse(objResponse.responseText);
	if (objModTimeInfo)
	{
		const strRigLetter = objModTimeInfo.rig;
		const objLocalRigInfo = gMapRigContents[strRigLetter];
		const nCacheModTime = objLocalRigInfo?.modTime && (parseInt(objLocalRigInfo.modTime) || 0);
		const nRemoteModTime = objModTimeInfo?.modTime && parseInt(objModTimeInfo.modTime);
		if (nRemoteModTime && (nRemoteModTime > nCacheModTime))
		{
			console.log(`--> Newer ${strRigLetter} rig content on server; clearing local cache & refetching`);
			// Remove from cache
			localStorage.removeItem(strRigLetter + kCacheRigSuffix);
			// And re-fetch
			loadRig(strRigLetter);
		}
		else
			console.log(`--> Local cache for ${strRigLetter} rig is up to date with server`);
	}
}


function response_storeReceivedRigContent()
{
	const objResponse = this;
	const strRigLetter = objResponse.strRigLetter;
	
	// Remove pending request for this rig's contents
	unpendRigRequest(strRigLetter);
	
	var objRigInfo = null;
	if (objResponse)
	{
		const strRigInfoJSON = objResponse.responseText;
		var objRigInfo = JSON.parse(strRigInfoJSON);
		if (objRigInfo)
		{
			// Cache this new version of contents to localStorage
			const strReceivedRigLetter = objRigInfo.rig || strRigLetter;
			console.log(`--> Rig contents for ${strReceivedRigLetter} rig received`);
			localStorage.setItem(strReceivedRigLetter + kCacheRigSuffix, strRigInfoJSON);
			
			// Only update in UI if this rig is still selected (user may have
			// unchecked its checkbox while the fetch results were being awaited)
			if (gMapRigToggles[strReceivedRigLetter]?.checked)
			{
				gMapRigContents[strReceivedRigLetter] = objRigInfo;
				updateSearchResults();
			}
		}
	}
	
	updateUIMode();
}


function clearCache()
{
	// Clear out each rig's content cache
	Object.keys(localStorage).
		filter(strKey => strKey.endsWith(kCacheRigSuffix)).
		forEach(strKey => localStorage.removeItem(strKey));
	
	// Unselect all rigs
	const arrRigCheckboxes = Object.values(gMapRigToggles);
	for (const i in arrRigCheckboxes)
	{
		const eltRigCheckbox = arrRigCheckboxes[i];
		eltRigCheckbox.checked = false;
		rigSelect_onClick(eltRigCheckbox);
	}
	
	// Empty the search text
	searchText_saveValueAndRefresh("");
	
	// Finally, reload the page to reset everything and update the set of rig toggles if needed
	window.location.reload();
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
	localStorage.setItem("searchText", strVal);
	updateSearchResults();
}


function rigSelect_onClick(eltRigCheckbox)
{
	const strRigLetter = eltRigCheckbox.name;
	if (eltRigCheckbox.checked)
		loadRig(strRigLetter);
	else
		removeRig(strRigLetter);
	
	const arrEnabledRigs = Object.values(gMapRigToggles).filter(elt => elt.checked).map(elt => elt.name);
	localStorage.setItem("enabledRigs", JSON.stringify(arrEnabledRigs));
}


function updateUIMode()
{
	// Show or hide status message, depending on whether any rigs are selected or not
	const bNoRigsSelected = !Object.values(gMapRigToggles).some(eltInput => eltInput.checked);
	const eltStatusMessage = document.getElementById("StatusMessage");
	eltStatusMessage.style.display = bNoRigsSelected? "block" : "none";
	
	// Show or hide "waiting" modal, depending on whether any content requests are pending
	const bPendingContentRequests = (Object.keys(gMapPendingContentRequests).length !== 0);
	showHideModal("AwaitResultsModal", bPendingContentRequests);
}


function showHideModal(strModalID, bShow)
{
	document.getElementById("ModalOverlay").style.display = bShow? "block" : "none";
	document.getElementById(strModalID).style.display = bShow? "block" : "none";
}


